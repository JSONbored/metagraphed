// The composition seam for the stake/unstake modal (#5242, native-staking
// epic #5229). Wires together every primitive built in #5236-#5241 into one
// real, clickable flow for a concrete (hotkey, netuid) pair. Every exported
// function that doesn't need React is a plain, directly-testable function --
// this codebase's convention is to test a hook's exported pure functions, not
// the hook itself via renderHook (this app has zero RTL/jsdom dependency).
//
// Scope: stake and unstake only. No move/swap here (see stake-extrinsics.ts's
// header comment on why a cross-subnet move_stake isn't a single safe call).

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWallet } from "./use-wallet";
import { useTxStatus, type TxUiStatus, type UseTxStatusResult } from "./use-tx-status";
import { useFlowSession, useFeeEstimate } from "./use-flow-session";
import { subnetStakeQuoteQuery, economicsQuery } from "@/lib/metagraphed/queries";
import type { SubnetStakeQuote } from "@/lib/metagraphed/types";
import { taoToRao, raoToTao, alphaToRawAlpha, asRao, type Rao } from "@/lib/metagraphed/units";
import {
  computeLimitPrice,
  buildAddStakeLimitParams,
  buildRemoveStakeLimitParams,
  validateStakeInputs,
  describeStakeValidationIssue,
  type AddStakeLimitParams,
  type RemoveStakeLimitParams,
  type StakeValidationIssue,
} from "@/lib/metagraphed/stake-extrinsics";
import {
  getMinStake,
  getFreeBalance,
  getNextNonce,
  buildExtrinsic,
} from "@/lib/metagraphed/chain-connection";
import { getSigner } from "@/lib/metagraphed/wallet-injected";
import { computeIdempotencyKey } from "@/lib/metagraphed/broadcast";

export type StakeFlowAction = "stake" | "unstake";
export type StakeFlowUnit = "tao" | "alpha";
export type StakeFlowPhase =
  "connect" | "amount" | "confirm" | "signing" | "broadcasting" | "failed" | "done";

/** Per ADR 0018 §3. */
export const DEFAULT_TOLERANCE_PCT = 5;

/**
 * A conservative placeholder for the stake-Max buffer, not the runtime's real
 * existential-deposit constant (worth confirming the same way getMinStake was
 * verified against the pallet -- a fast-follow, see the PR description).
 * Erring toward a larger buffer is the safe direction, not the risky one.
 */
export const DEFAULT_STAKE_BUFFER_RAO: Rao = taoToRao("0.02");

/** Legacy position fields do not establish token quantities for any subnet. */
export const MAX_UNSTAKE_UNAVAILABLE_MESSAGE =
  "Max is unavailable because recorded positions do not establish token quantities.";

/**
 * Derives the flow's phase purely from the wallet/tx-status state this hook
 * already tracks -- no parallel status enum to keep in sync. `confirmed`
 * latches: once true, only editAmount()/close() can move the flow back to
 * "amount"; a txStatus reset (retrying after a failure) returns to "confirm",
 * not all the way back to the amount-entry step.
 */
export function deriveStakeFlowPhase(
  walletStatus: string,
  confirmed: boolean,
  txStatus: TxUiStatus,
): StakeFlowPhase {
  if (walletStatus !== "connected") return "connect";
  if (!confirmed) return "amount";
  if (txStatus === "idle") return "confirm";
  if (txStatus === "signing") return "signing";
  if (txStatus === "failed" || txStatus === "submit-error") return "failed";
  if (txStatus === "finalized") return "done";
  return "broadcasting";
}

/**
 * The Sheet must not be dismissible mid-flight -- signAndSend runs outside
 * React's control, so closing the UI doesn't cancel it (broadcast.ts's own
 * header comment). Only these terminal-or-not-yet-started statuses are safe
 * to close from.
 */
export function canCloseStakeFlow(txStatus: TxUiStatus): boolean {
  return (
    txStatus === "idle" ||
    txStatus === "failed" ||
    txStatus === "submit-error" ||
    txStatus === "finalized"
  );
}

/**
 * A first-pass alpha estimate for an unstake TAO target, given the best
 * currently-known spot price -- a CANDIDATE only, always superseded by the
 * real subnetStakeQuoteQuery response's expected_out for display. Only a
 * matching successful quote can authorize that candidate as final RawAlpha.
 * Rounds through a fixed 9-decimal string, never a raw float divide passed
 * straight to a bigint parse -- same rule computeLimitPrice follows.
 */
export function computeUnstakeAlphaCandidate(taoTarget: string, spotPriceTao: number): string {
  const target = Number(taoTarget);
  if (
    !Number.isFinite(target) ||
    target <= 0 ||
    !Number.isFinite(spotPriceTao) ||
    spotPriceTao <= 0
  ) {
    return "0";
  }
  // NOT display formatting: this string is parsed straight back into RAO by
  // `taoToRao`, and 9 decimals is TAO's on-chain precision exactly. It is
  // therefore the one place outside format.ts where `toFixed` is correct --
  // rounding it anywhere else would change the amount a transaction moves.
  // eslint-disable-next-line no-restricted-syntax -- transaction amount, not display
  return (target / spotPriceTao).toFixed(9);
}

/** A quote amount is TAO when staking and alpha when unstaking. */
export function resolveStakeQuoteAmount(
  action: StakeFlowAction,
  unit: StakeFlowUnit,
  amountInput: string,
  spotPriceTao: number | null | undefined,
): number | null {
  const amount = Number(amountInput);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (action === "stake" || unit === "alpha") return amount;
  if (spotPriceTao == null || !Number.isFinite(spotPriceTao) || spotPriceTao <= 0) return null;
  const alpha = Number(computeUnstakeAlphaCandidate(amountInput, spotPriceTao));
  return Number.isFinite(alpha) && alpha > 0 ? alpha : null;
}

/** A price for another subnet cannot value this subnet's alpha. */
export function stakeQuoteSpotPrice(
  quote: Pick<SubnetStakeQuote, "netuid" | "spot_price_tao"> | null,
  netuid: number,
): number | null {
  if (
    quote == null ||
    quote.netuid !== netuid ||
    !Number.isFinite(quote.spot_price_tao) ||
    quote.spot_price_tao <= 0
  ) {
    return null;
  }
  return quote.spot_price_tao;
}

/** getFreeBalance() minus a conservative buffer, floored at zero rather than going negative. */
export function resolveStakeMaxRao(
  freeBalanceRao: Rao,
  bufferRao: Rao = DEFAULT_STAKE_BUFFER_RAO,
): Rao {
  const max = freeBalanceRao - bufferRao;
  return asRao(max > 0n ? max : 0n);
}

/**
 * The TAO-equivalent estimate for validateStakeInputs' floor/balance checks
 * on a remove_stake_limit (its own doc comment: "already converted to rao
 * ... or its TAO-equivalent estimate"). Rounded through a fixed 9-decimal
 * string before taoToRao's strict parse -- quote.expected_out is a raw float
 * from the API and routinely carries more than 9 fractional digits (e.g.
 * 4.997553120472154), which would otherwise throw. A real regression: this
 * ran unguarded inside a useMemo and crashed the whole route on a live
 * quote, not just the modal, until caught in manual QA.
 */
export function resolveUnstakeValidationAmountRao(expectedOutTao: number): Rao {
  const safe = Number.isFinite(expectedOutTao) ? expectedOutTao : 0;
  // eslint-disable-next-line no-restricted-syntax -- transaction amount, not display
  return asRao(taoToRao(safe.toFixed(9)));
}

export interface BuildStakeCallParamsInput {
  action: StakeFlowAction;
  hotkey: string;
  netuid: number;
  amountInput: string;
  unit: StakeFlowUnit;
  /** Best currently-known spot price (TAO per alpha) -- the live quote's when resolved, else a bootstrap. */
  spotPriceTao: number;
  tolerancePct: number;
}

/**
 * The one place amount+unit+direction turns into an actual extrinsic-param
 * object -- the fund-safety-critical seam this whole hook exists to get
 * right. Never throws: any malformed input (an unparseable amount string, an
 * invalid spot price/tolerance) resolves to null rather than crashing mid-
 * render, since this is called on every render while the user is still
 * typing.
 */
export function buildStakeCallParams(
  input: BuildStakeCallParamsInput,
): AddStakeLimitParams | RemoveStakeLimitParams | null {
  const { action, hotkey, netuid, amountInput, unit, spotPriceTao, tolerancePct } = input;
  try {
    if (action === "stake") {
      const amountStaked = taoToRao(amountInput);
      if (amountStaked <= 0n) return null;
      const limitPrice = computeLimitPrice({ spotPriceTao, tolerancePct, direction: "add" });
      return buildAddStakeLimitParams({
        hotkey,
        netuid,
        amountStaked,
        limitPrice,
        allowPartial: false,
      });
    }
    const alphaCandidate =
      unit === "alpha" ? amountInput : computeUnstakeAlphaCandidate(amountInput, spotPriceTao);
    const amountUnstaked = alphaToRawAlpha(alphaCandidate);
    if (amountUnstaked <= 0n) return null;
    const limitPrice = computeLimitPrice({ spotPriceTao, tolerancePct, direction: "remove" });
    return buildRemoveStakeLimitParams({
      hotkey,
      netuid,
      amountUnstaked,
      limitPrice,
      allowPartial: false,
    });
  } catch {
    return null;
  }
}

export interface StakeFlowIntent {
  action: StakeFlowAction;
  hotkey: string;
  netuid: number;
  amountInput: string;
  unit: StakeFlowUnit;
  tolerancePct: number;
  signerAddress: string | null;
}

export interface StakeConfirmation {
  intent: StakeFlowIntent;
  quote: SubnetStakeQuote;
  params: AddStakeLimitParams | RemoveStakeLimitParams;
}

/** Bind the call to the amount actually quoted, not a new spot conversion. */
export function createStakeConfirmation(
  intent: StakeFlowIntent,
  quoteAmount: number | null,
  quote: SubnetStakeQuote | null,
): StakeConfirmation | null {
  const spotPriceTao = stakeQuoteSpotPrice(quote, intent.netuid);
  const typedAmount = Number(intent.amountInput);
  if (
    !intent.signerAddress ||
    !Number.isFinite(typedAmount) ||
    typedAmount <= 0 ||
    quote == null ||
    quoteAmount == null ||
    !Number.isFinite(quoteAmount) ||
    quoteAmount <= 0 ||
    quote.direction !== intent.action ||
    quote.amount !== quoteAmount ||
    ((intent.action === "stake" || intent.unit === "alpha") && typedAmount !== quoteAmount) ||
    quote.expected_out_unit !== (intent.action === "stake" ? "alpha" : "tao") ||
    !Number.isFinite(quote.expected_out) ||
    quote.expected_out < 0 ||
    spotPriceTao == null
  ) {
    return null;
  }
  // This is a transaction amount, not display formatting. Refuse any
  // precision loss rather than signing a different quantity from the quote.
  // eslint-disable-next-line no-restricted-syntax -- transaction amount, not display
  const quotedAmountInput = quoteAmount.toFixed(9);
  if (Number(quotedAmountInput) !== quoteAmount) return null;
  try {
    const typedRaw =
      intent.action === "unstake" && intent.unit === "alpha"
        ? alphaToRawAlpha(intent.amountInput)
        : taoToRao(intent.amountInput);
    const quotedRaw =
      intent.action === "unstake"
        ? alphaToRawAlpha(quotedAmountInput)
        : taoToRao(quotedAmountInput);
    if (typedRaw <= 0n) return null;
    if ((intent.action === "stake" || intent.unit === "alpha") && typedRaw !== quotedRaw) return null;
  } catch {
    return null;
  }
  const params = buildStakeCallParams({
    ...intent,
    amountInput: quotedAmountInput,
    unit: intent.action === "unstake" ? "alpha" : "tao",
    spotPriceTao,
  });
  return params ? { intent: { ...intent }, quote: { ...quote }, params } : null;
}

/** An old confirmation cannot authorize another signer, validator or input. */
export function stakeConfirmationMatches(
  confirmation: StakeConfirmation | null,
  intent: StakeFlowIntent,
): confirmation is StakeConfirmation {
  return (
    confirmation != null &&
    confirmation.intent.hotkey === intent.hotkey &&
    confirmation.intent.netuid === intent.netuid &&
    confirmation.intent.action === intent.action &&
    confirmation.intent.unit === intent.unit &&
    confirmation.intent.amountInput === intent.amountInput &&
    confirmation.intent.tolerancePct === intent.tolerancePct &&
    confirmation.intent.signerAddress === intent.signerAddress
  );
}

export interface UseStakeFlowResult {
  phase: StakeFlowPhase;
  wallet: ReturnType<typeof useWallet>;

  action: StakeFlowAction;
  setAction: (action: StakeFlowAction) => void;
  unit: StakeFlowUnit;
  setUnit: (unit: StakeFlowUnit) => void;
  amountInput: string;
  setAmountInput: (value: string) => void;
  tolerancePct: number;
  setTolerancePct: (value: number) => void;

  quote: SubnetStakeQuote | null;
  quoteIsPending: boolean;
  quoteError: string | null;
  spotPriceTao: number | null;

  freeBalanceRao: Rao | null;
  maxStakeRao: Rao | null;
  maxUnstakeAmountInput: string | null;
  maxUnstakeUnavailable: boolean;
  positionCapturedAt: string | null;
  applyMaxStake: () => void;
  applyMaxUnstake: () => void;

  params: AddStakeLimitParams | RemoveStakeLimitParams | null;
  feeTao: string | null;
  validationIssues: StakeValidationIssue[];
  validationMessages: string[];
  canConfirm: boolean;
  confirm: () => void;
  editAmount: () => void;

  txStatus: UseTxStatusResult;
  submit: () => Promise<void>;
  canClose: boolean;
  close: () => void;
}

/** #5242's composition seam for one concrete (hotkey, netuid) stake/unstake flow. */
export function useStakeFlow(hotkey: string, netuid: number): UseStakeFlowResult {
  const wallet = useWallet();
  const txStatus = useTxStatus();

  const [action, setAction] = useState<StakeFlowAction>("stake");
  const [unit, setUnit] = useState<StakeFlowUnit>("tao");
  const [amountInput, setAmountInput] = useState("");
  const [tolerancePct, setTolerancePct] = useState(DEFAULT_TOLERANCE_PCT);
  const [confirmation, setConfirmation] = useState<StakeConfirmation | null>(null);

  // Shared across all three stake/take flows -- see use-flow-session.ts.
  const { sessionId, api } = useFlowSession(wallet.status);

  const [freeBalanceRao, setFreeBalanceRao] = useState<Rao | null>(null);
  const [minStakeRao, setMinStakeRao] = useState<Rao | null>(null);
  const coldkeyAddress = wallet.wallet?.address ?? null;
  const intent = useMemo<StakeFlowIntent>(
    () => ({ action, hotkey, netuid, amountInput, unit, tolerancePct, signerAddress: coldkeyAddress }),
    [action, hotkey, netuid, amountInput, unit, tolerancePct, coldkeyAddress],
  );
  const activeConfirmation = stakeConfirmationMatches(confirmation, intent) ? confirmation : null;
  const confirmed = activeConfirmation != null;
  useEffect(() => {
    if (confirmation != null && !stakeConfirmationMatches(confirmation, intent)) {
      setConfirmation(null);
    }
  }, [confirmation, intent]);
  useEffect(() => {
    if (!api || !coldkeyAddress) return;
    let cancelled = false;
    Promise.all([getFreeBalance(api, coldkeyAddress), getMinStake(api)])
      .then(([free, min]) => {
        if (!cancelled) {
          setFreeBalanceRao(free);
          setMinStakeRao(min);
        }
      })
      .catch(() => {
        /* best-effort; Max button + the min-stake validation issue just stay unavailable */
      });
    return () => {
      cancelled = true;
    };
  }, [api, coldkeyAddress]);

  const economicsQ = useQuery(economicsQuery({ fields: "detail" }));
  const bootstrapSpotPriceTao =
    economicsQ.data?.data.find((row) => row.netuid === netuid)?.alpha_price_tao ?? null;

  // Holds steady across a query-key change mid-flight (tanstack query resets
  // `data` to undefined for a brand-new key), so the unstake+TAO-mode
  // candidate doesn't bounce back to the bootstrap price and re-derive a
  // different candidate on every refetch -- see this hook's own header
  // comment on the fund-safety cost of that class of bug.
  const [retainedSpotPrice, setRetainedSpotPrice] = useState<{
    netuid: number;
    value: number;
  } | null>(null);
  const lastKnownSpotPriceTao = retainedSpotPrice?.netuid === netuid ? retainedSpotPrice.value : null;
  const priorSpotPriceTao = lastKnownSpotPriceTao ?? bootstrapSpotPriceTao;
  const quoteAmount = resolveStakeQuoteAmount(action, unit, amountInput, priorSpotPriceTao);
  const quotePriceUnavailable =
    action === "unstake" &&
    unit === "tao" &&
    (priorSpotPriceTao == null || !Number.isFinite(priorSpotPriceTao) || priorSpotPriceTao <= 0);

  const quoteOptions = subnetStakeQuoteQuery(netuid, quoteAmount ?? 0, action);
  const quoteQ = useQuery({
    // Zero is a disabled query-key placeholder, never a substitute quote.
    ...quoteOptions,
    // A cached amount alone cannot authorize another validator or form intent.
    queryKey: [...quoteOptions.queryKey, hotkey, unit, amountInput, tolerancePct, coldkeyAddress],
    enabled: quoteAmount != null && !confirmed,
  });
  const currentQuote = quoteAmount != null ? (quoteQ.data?.data ?? null) : null;
  const quotedSpotPriceTao = stakeQuoteSpotPrice(currentQuote, netuid);

  useEffect(() => {
    if (!confirmed && quotedSpotPriceTao != null) {
      setRetainedSpotPrice({ netuid, value: quotedSpotPriceTao });
    }
  }, [confirmed, netuid, quotedSpotPriceTao]);

  const spotPriceTao =
    activeConfirmation?.quote.spot_price_tao ??
    quotedSpotPriceTao ??
    lastKnownSpotPriceTao ??
    bootstrapSpotPriceTao;

  const candidate = useMemo(
    () =>
      quoteQ.isSuccess && !quoteQ.isFetching
        ? createStakeConfirmation(intent, quoteAmount, currentQuote)
        : null,
    [intent, quoteAmount, currentQuote, quoteQ.isSuccess, quoteQ.isFetching],
  );
  const params = activeConfirmation?.params ?? candidate?.params ?? null;
  const quote = activeConfirmation?.quote ?? candidate?.quote ?? null;

  const validationIssues = useMemo(() => {
    if (!params || minStakeRao == null) return [];
    const amountRao =
      params.call === "add_stake_limit"
        ? params.amountStaked
        : resolveUnstakeValidationAmountRao(quote?.expected_out ?? 0);
    return validateStakeInputs({
      hotkey,
      netuid,
      // The concrete netuid this modal opened for is always an already-active
      // subnet (sourced from a real per-hotkey registration row) -- this
      // hook never fetches its own copy of the master subnet list, so the
      // check is a tautology here rather than dead weight.
      knownNetuids: [netuid],
      amountRao,
      minStakeRao,
      availableBalanceRao: action === "stake" ? (freeBalanceRao ?? undefined) : undefined,
    });
  }, [params, minStakeRao, hotkey, netuid, quote?.expected_out, action, freeBalanceRao]);

  const validationMessages = useMemo(
    () => validationIssues.map(describeStakeValidationIssue),
    [validationIssues],
  );

  const canConfirm =
    !confirmed &&
    candidate != null &&
    validationIssues.length === 0 &&
    quoteQ.isSuccess &&
    !quoteQ.isFetching;

  const maxStakeRao = freeBalanceRao != null ? resolveStakeMaxRao(freeBalanceRao) : null;

  // Fee dry-run for the PreSignConfirmation screen -- only ever fetched once
  // the user has reached "confirm" with a resolved, idle tx, so an amount
  // that's still being edited never fires a paymentInfo() round-trip.
  const feeRao = useFeeEstimate(confirmed, txStatus.status, api, wallet.wallet, params);

  const applyMaxStake = useCallback(() => {
    if (maxStakeRao != null) setAmountInput(raoToTao(maxStakeRao));
  }, [maxStakeRao]);

  const applyMaxUnstake = useCallback(() => undefined, []);

  const confirm = useCallback(() => {
    if (canConfirm && candidate != null) setConfirmation(candidate);
  }, [canConfirm, candidate]);
  const editAmount = useCallback(() => {
    setConfirmation(null);
    txStatus.reset();
  }, [txStatus]);

  const close = useCallback(() => {
    txStatus.reset();
    setConfirmation(null);
    setAmountInput("");
  }, [txStatus]);

  const submit = useCallback(async () => {
    if (!api || !wallet.wallet || !activeConfirmation || validationIssues.length > 0) return;
    const confirmedParams = activeConfirmation.params;
    const nonce = await getNextNonce(api, wallet.wallet.address);
    const idempotencyKey = computeIdempotencyKey(confirmedParams, nonce, sessionId);
    const extrinsic = buildExtrinsic(api, confirmedParams);
    const signer = await getSigner(wallet.wallet.source);
    await txStatus.submit(api, extrinsic, {
      signerAddress: wallet.wallet.address,
      signer,
      idempotencyKey,
    });
  }, [api, wallet.wallet, activeConfirmation, validationIssues.length, sessionId, txStatus]);

  const phase = deriveStakeFlowPhase(wallet.status, confirmed, txStatus.status);

  return {
    phase,
    wallet,
    action,
    setAction,
    unit,
    setUnit,
    amountInput,
    setAmountInput,
    tolerancePct,
    setTolerancePct,
    quote,
    quoteIsPending: !confirmed && quoteAmount != null && (quoteQ.isPending || quoteQ.isFetching),
    quoteError: confirmed
      ? null
      : quotePriceUnavailable
        ? "A TAO-per-alpha price is unavailable. Enter an alpha amount or try again later."
        : quoteQ.isError
          ? quoteQ.error instanceof Error
            ? quoteQ.error.message
            : "Could not compute a quote."
          : quoteQ.isSuccess && !quoteQ.isFetching && quoteAmount != null && candidate == null
            ? "A matching quote is unavailable for this staking request."
            : null,
    spotPriceTao,
    freeBalanceRao,
    maxStakeRao,
    maxUnstakeAmountInput: null,
    maxUnstakeUnavailable: true,
    positionCapturedAt: null,
    applyMaxStake,
    applyMaxUnstake,
    params,
    feeTao: feeRao != null ? raoToTao(feeRao) : null,
    validationIssues,
    validationMessages,
    canConfirm,
    confirm,
    editAmount,
    txStatus,
    submit,
    canClose: canCloseStakeFlow(txStatus.status),
    close,
  };
}
