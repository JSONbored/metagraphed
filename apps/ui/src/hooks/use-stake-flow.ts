// The composition seam for the stake/unstake modal (#5242, native-staking
// epic #5229). Wires together every primitive built in #5236-#5241 into one
// real, clickable flow for a concrete (hotkey, netuid) pair. Every exported
// function that doesn't need React is a plain, directly-testable function --
// this codebase's convention is to test a hook's exported pure functions, not
// the hook itself via renderHook (this app has zero RTL/jsdom dependency).
//
// Scope: stake and unstake only. No move/swap here (see stake-extrinsics.ts's
// header comment on why a cross-subnet move_stake isn't a single safe call).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWallet } from "./use-wallet";
import { useTxStatus, type TxUiStatus, type UseTxStatusResult } from "./use-tx-status";
import { useFlowSession, useFeeEstimate } from "./use-flow-session";
import { nativeStakeHoldingQuery, nativeUnstakeMax } from "@/lib/metagraphed/native-stake-holding";
import { nativeStakeInput, nativeStakeParams, nativeStakeQuoteQuery, prepareNativeStakeCall, type NativeStakeQuote } from "@/lib/metagraphed/native-stake-quote";
import { guardNativeSigner, previewNativeCall, revalidateNativeCall } from "@/lib/metagraphed/native-call-wallet";
import { getApiBase, getNetwork } from "@/lib/metagraphed/config";
import { getConnectedWallet } from "@/lib/metagraphed/wallet";
import type { SubnetStakeQuote, AccountPosition } from "@/lib/metagraphed/types";
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

/** #5233's positions endpoint has zero root coverage (see AccountPositions' doc comment, types.ts). */
export const MAX_UNSTAKE_UNAVAILABLE_ROOT_MESSAGE = "Max isn't available for root stake yet.";

export function stakeWalletContext(): string {
  const wallet = getConnectedWallet();
  return `${getApiBase()}:${getNetwork().id}:${wallet?.address}:${wallet?.source}`;
}

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
 * real subnetStakeQuoteQuery response's expected_out for display, and never
 * itself the final RawAlpha unless the caller is still waiting on that quote.
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

/** getFreeBalance() minus a conservative buffer, floored at zero rather than going negative. */
export function resolveStakeMaxRao(
  freeBalanceRao: Rao,
  bufferRao: Rao = DEFAULT_STAKE_BUFFER_RAO,
): Rao {
  const max = freeBalanceRao - bufferRao;
  return asRao(max > 0n ? max : 0n);
}

/**
 * The stale-labeled Max prefill for unstake (see AccountPositions' doc
 * comment for why this is never authoritative). Unit-aware: alpha mode needs
 * no price at all (stake_tao itself is display-only there); TAO mode returns
 * the position's TAO figure directly. Reuses computeUnstakeAlphaCandidate for
 * the alpha-mode conversion -- the same best-effort estimate used for the
 * live TAO-mode quote candidate, not a second, differently-precise path.
 */
export function resolveUnstakeMaxAmountInput(
  position: AccountPosition | null,
  unit: StakeFlowUnit,
  spotPriceTao: number,
): string | null {
  if (position == null) return null;
  if (unit === "alpha") {
    return computeUnstakeAlphaCandidate(String(position.stake_tao), spotPriceTao);
  }
  // Rounded to 9 decimals like every other amount this hook ever displays or
  // parses -- stake_tao is a server-computed float (share_fraction * live
  // stake) and routinely carries more precision than a single rao can
  // represent, which would otherwise surface as an ugly, over-precise
  // prefilled value in the amount field.
  // eslint-disable-next-line no-restricted-syntax -- transaction amount, not display
  return position.stake_tao.toFixed(9);
}

/** Root (netuid 0) has zero coverage in the nominator-positions source. */
export function isMaxUnavailableForNetuid(netuid: number): boolean {
  return netuid === 0;
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
  const [confirmed, setConfirmed] = useState(false);
  const [reviewed, setReviewed] = useState<{
    params: AddStakeLimitParams | RemoveStakeLimitParams;
    quote: NativeStakeQuote;
    address: string;
    source: string;
    sessionId: string;
    context: string;
  } | null>(null);

  // Shared across all three stake/take flows -- see use-flow-session.ts.
  const { sessionId, api } = useFlowSession(wallet.status);

  const [balances, setBalances] = useState<{
    api: NonNullable<typeof api>;
    address: string;
    free: Rao;
    minimum: Rao;
  } | null>(null);
  const coldkeyAddress = wallet.wallet?.address ?? null;
  const freeBalanceRao = balances?.api === api && balances.address === coldkeyAddress ? balances.free : null;
  const minStakeRao = balances?.api === api && balances.address === coldkeyAddress ? balances.minimum : null;
  const active = useRef(true);
  const working = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  useEffect(() => {
    setConfirmed(false);
    setReviewed(null);
    txStatus.reset();
  }, [coldkeyAddress, wallet.wallet?.source, api, sessionId, hotkey, netuid, txStatus.reset]);
  useEffect(() => {
    setBalances(null);
    if (!api || !coldkeyAddress) return;
    let cancelled = false;
    Promise.all([getFreeBalance(api, coldkeyAddress), getMinStake(api)])
      .then(([free, min]) => {
        if (!cancelled) {
          setBalances({ api, address: coldkeyAddress, free, minimum: min });
        }
      })
      .catch(() => {
        /* best-effort; Max button + the min-stake validation issue just stay unavailable */
      });
    return () => {
      cancelled = true;
    };
  }, [api, coldkeyAddress]);

  const inputAtomic = nativeStakeInput(amountInput);
  const quoteQ = useQuery({ ...nativeStakeQuoteQuery(netuid, inputAtomic, action, unit), enabled: inputAtomic !== null && !confirmed });
  const liveQuote = quoteQ.data ?? null;
  const quote = confirmed && reviewed ? reviewed.quote : liveQuote;
  const spotPriceTao = quote?.spot_price_tao ?? null;

  const holdingQ = useQuery({
    ...nativeStakeHoldingQuery(hotkey, coldkeyAddress, netuid),
    enabled: !!coldkeyAddress && action === "unstake",
  });

  const liveParams = useMemo(() => {
    if (!liveQuote) return null;
    try { return nativeStakeParams(liveQuote, hotkey, tolerancePct); }
    catch { return null; }
  }, [liveQuote, hotkey, tolerancePct]);
  const params = confirmed && reviewed ? reviewed.params : liveParams;

  const validationIssues = useMemo(() => {
    if (!params || minStakeRao == null) return [];
    const amountRao =
      params.call === "add_stake_limit"
        ? params.amountStaked
        : asRao(quote?.outputAtomic ?? 0n);
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
  }, [params, minStakeRao, hotkey, netuid, quote?.outputAtomic, action, freeBalanceRao]);

  const validationMessages = useMemo(
    () => validationIssues.map(describeStakeValidationIssue),
    [validationIssues],
  );

  const canConfirm =
    api != null && wallet.wallet != null && minStakeRao != null && freeBalanceRao != null &&
    liveParams != null && validationIssues.length === 0 && quoteQ.isSuccess && !quoteQ.isFetching;

  const maxStakeRao = freeBalanceRao != null ? resolveStakeMaxRao(freeBalanceRao) : null;
  const maxUnstakeUnavailable = false;
  const maxUnstakeAmountInput = nativeUnstakeMax(holdingQ.data ?? null, unit);

  // Fee dry-run for the PreSignConfirmation screen -- only ever fetched once
  // the user has reached "confirm" with a resolved, idle tx, so an amount
  // that's still being edited never fires a paymentInfo() round-trip.
  const feeRao = useFeeEstimate(confirmed, txStatus.status, api, wallet.wallet, params);

  const applyMaxStake = useCallback(() => {
    if (maxStakeRao != null) setAmountInput(raoToTao(maxStakeRao));
  }, [maxStakeRao]);

  const applyMaxUnstake = useCallback(() => {
    if (maxUnstakeAmountInput != null) setAmountInput(maxUnstakeAmountInput);
  }, [maxUnstakeAmountInput]);

  const confirm = useCallback(() => {
    if (!canConfirm || !liveParams || !liveQuote || !wallet.wallet) return;
    setReviewed({ params: { ...liveParams }, quote: { ...liveQuote, source: { ...liveQuote.source } }, address: wallet.wallet.address, source: wallet.wallet.source, sessionId, context: stakeWalletContext() });
    setConfirmed(true);
  }, [canConfirm, liveParams, liveQuote, wallet.wallet, sessionId]);
  const editAmount = useCallback(() => {
    setConfirmed(false);
    setReviewed(null);
    txStatus.reset();
  }, [txStatus]);

  const close = useCallback(() => {
    txStatus.reset();
    setConfirmed(false);
    setReviewed(null);
    setAmountInput("");
  }, [txStatus]);

  const submit = useCallback(async () => {
    if (working.current || !api || !reviewed || feeRao === null) return;
    working.current = true;
    const assertCurrent = () => {
      if (!active.current || stakeWalletContext() !== reviewed.context)
        throw new Error("The account, network or API changed. Review this stake again.");
    };
    try {
      assertCurrent();
      const artifact = await prepareNativeStakeCall(reviewed.quote, reviewed.params);
      assertCurrent();
      const preview = await previewNativeCall(api, artifact, 0, reviewed.address);
      assertCurrent();
      if (preview.feeRao > feeRao + (feeRao + 9n) / 10n)
        throw new Error("The transaction fee changed. Review this stake again.");
      if (reviewed.params.call === "add_stake_limit" && preview.balanceRao < reviewed.params.amountStaked + preview.maxFeeRao)
        throw new Error("The spendable balance cannot cover this stake and its fee.");
      const connected = await getSigner(reviewed.source);
      assertCurrent();
      const recheck = async () => {
        await revalidateNativeCall(api, preview);
        if (reviewed.params.call === "add_stake_limit" && await getFreeBalance(api, reviewed.address) < reviewed.params.amountStaked + preview.maxFeeRao)
          throw new Error("The spendable balance changed. Review this stake again.");
      };
      await recheck();
      assertCurrent();
      const signer = guardNativeSigner(connected, preview, assertCurrent, recheck);
      await txStatus.submit(api, preview.extrinsic, {
        signerAddress: reviewed.address,
        signer,
        nonce: preview.nonce,
        idempotencyKey: computeIdempotencyKey({ callData: preview.callData, address: reviewed.address, genesisHash: preview.source.network_genesis_hash }, preview.nonce, reviewed.sessionId),
      });
    } finally { working.current = false; }
  }, [api, reviewed, feeRao, txStatus]);

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
    quoteIsPending: quoteQ.isPending,
    quoteError: quoteQ.isError
      ? quoteQ.error instanceof Error
        ? quoteQ.error.message
        : "Could not compute a quote."
      : null,
    spotPriceTao,
    freeBalanceRao,
    maxStakeRao,
    maxUnstakeAmountInput,
    maxUnstakeUnavailable,
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
