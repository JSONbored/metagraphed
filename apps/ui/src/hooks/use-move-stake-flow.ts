// The composition seam for the move/re-delegate stake flow (#5244, native-
// staking epic #5229). Mirrors use-stake-flow.ts's structure and conventions
// closely (same phase-derivation shape, same SSR-safe session id, same
// exported-pure-function testing convention) but composes a DIFFERENT pair of
// already-built, already-reviewed extrinsics instead of add/remove_stake_limit
// -- see buildMoveStakeCallParams below for the fund-safety-critical seam this
// hook exists to get right. No new signing logic: every chain-facing call
// still goes through stake-extrinsics.ts / chain-connection.ts / broadcast.ts
// unchanged.
//
// Scope: a single-axis move only -- either the hotkey changes (same subnet,
// via move_stake) or the subnet changes (same hotkey, via swap_stake_limit).
// stake-extrinsics.ts's own header comment documents why there is no single
// safe call for changing both at once (it would need a new two-leg
// remove_stake_limit + add_stake_limit composition) -- this flow refuses that
// case rather than approximating it.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ApiPromise } from "@polkadot/api";
import { useWallet } from "./use-wallet";
import { useTxStatus, type TxUiStatus, type UseTxStatusResult } from "./use-tx-status";
import { DEFAULT_TOLERANCE_PCT } from "./use-stake-flow";
import { subnetStakeQuoteQuery, subnetsQuery } from "@/lib/metagraphed/queries";
import type { SubnetStakeQuote, Subnet } from "@/lib/metagraphed/types";
import {
  taoToRao,
  raoToTao,
  alphaToRawAlpha,
  rawAlphaToAlpha,
  type Rao,
} from "@/lib/metagraphed/units";
import {
  computeLimitPrice,
  buildMoveStakeParams,
  buildSwapStakeLimitParams,
  validateStakeInputs,
  describeStakeValidationIssue,
  type MoveStakeParams,
  type SwapStakeLimitParams,
  type StakeValidationIssue,
} from "@/lib/metagraphed/stake-extrinsics";
import {
  getApi,
  getMinStake,
  getNextNonce,
  buildExtrinsic,
} from "@/lib/metagraphed/chain-connection";
import { getSigner } from "@/lib/metagraphed/wallet-injected";
import { computeIdempotencyKey } from "@/lib/metagraphed/broadcast";
import { estimateFee } from "@/lib/metagraphed/tx-fee";

export type MoveStakeFlowPhase =
  "connect" | "amount" | "confirm" | "signing" | "broadcasting" | "failed" | "done";

/** Identical shape to deriveStakeFlowPhase (use-stake-flow.ts) -- see that function's doc comment for the phase-transition rationale, unchanged here. */
export function deriveMoveStakeFlowPhase(
  walletStatus: string,
  confirmed: boolean,
  txStatus: TxUiStatus,
): MoveStakeFlowPhase {
  if (walletStatus !== "connected") return "connect";
  if (!confirmed) return "amount";
  if (txStatus === "idle") return "confirm";
  if (txStatus === "signing") return "signing";
  if (txStatus === "failed" || txStatus === "submit-error") return "failed";
  if (txStatus === "finalized") return "done";
  return "broadcasting";
}

/** Identical to canCloseStakeFlow (use-stake-flow.ts). */
export function canCloseMoveStakeFlow(txStatus: TxUiStatus): boolean {
  return (
    txStatus === "idle" ||
    txStatus === "failed" ||
    txStatus === "submit-error" ||
    txStatus === "finalized"
  );
}

export type MoveStakeAxis = "hotkey" | "subnet";

/**
 * Which single axis a proposed destination changes relative to the origin
 * position -- "hotkey" (re-delegate, same subnet), "subnet" (move to a
 * different subnet, same hotkey), "unchanged" (nothing to do yet), or "both"
 * (changing hotkey AND subnet at once). Only "hotkey" and "subnet" are
 * buildable -- see this module's header comment for why "both" is refused
 * rather than approximated.
 */
export function resolveMoveStakeAxis(
  originHotkey: string,
  originNetuid: number,
  destinationHotkey: string,
  destinationNetuid: number,
): MoveStakeAxis | "unchanged" | "both" {
  const hotkeyChanged = destinationHotkey.trim() !== originHotkey.trim();
  const netuidChanged = destinationNetuid !== originNetuid;
  if (hotkeyChanged && netuidChanged) return "both";
  if (hotkeyChanged) return "hotkey";
  if (netuidChanged) return "subnet";
  return "unchanged";
}

/** Human-readable copy for the two non-buildable axis states, for the destination-picker step. */
export function describeMoveStakeAxisIssue(axis: "unchanged" | "both"): string {
  if (axis === "both") {
    return "Move a hotkey or a subnet in one step, not both — do this as two separate moves.";
  }
  return "Choose a different hotkey or subnet to move this position to.";
}

/** Root (netuid 0) has no AMM -- its alpha is TAO 1:1, so the position's own TAO figure IS the moveable amount. Mirrors buildUnifiedPositions'/computeLimitPrice's existing root-as-1.0 treatment. */
export function resolveMoveStakeMaxAmountInput(
  isRoot: boolean,
  positionAlpha: number | null,
  positionSpotTao: number,
): string | null {
  if (isRoot) return positionSpotTao > 0 ? positionSpotTao.toFixed(9) : null;
  return positionAlpha != null && positionAlpha > 0 ? positionAlpha.toFixed(9) : null;
}

/** The origin subnet's spot price (TAO per alpha), derived from the position data the caller already has -- no extra fetch. Root is fixed 1.0 (no AMM); an alpha subnet derives price = spotTao / alpha, null if that position's alpha is itself unknown. */
export function resolveOriginSpotPriceTao(
  isRoot: boolean,
  positionAlpha: number | null,
  positionSpotTao: number,
): number | null {
  if (isRoot) return 1;
  if (positionAlpha == null || positionAlpha <= 0) return null;
  return positionSpotTao / positionAlpha;
}

/**
 * A spot-mark TAO-value estimate for an alpha amount (the same "current
 * value" math YourPositionsPanel already displays per row) -- used for the
 * axis-"hotkey" confirm screen, which has no AMM quote to draw from since a
 * same-subnet hotkey move is a pure reassignment. Rounded through a fixed
 * 9-decimal string via taoToRao/raoToTao, the same rounding path every other
 * display amount in this app takes, rather than a raw toFixed with ad hoc
 * trailing-zero trimming.
 */
export function formatSpotValueTao(alphaAmount: number, spotPriceTao: number): string {
  const value =
    Number.isFinite(alphaAmount) && Number.isFinite(spotPriceTao) ? alphaAmount * spotPriceTao : 0;
  return raoToTao(taoToRao(Math.max(value, 0).toFixed(9)));
}

export interface BuildMoveStakeCallParamsInput {
  axis: MoveStakeAxis;
  originHotkey: string;
  originNetuid: number;
  destinationHotkey: string;
  destinationNetuid: number;
  alphaAmountInput: string;
  /** Only read for axis "subnet" -- the ORIGIN netuid's live spot price, the leg swap_stake_limit's limit_price actually protects (see doc comment below). */
  originSpotPriceTao: number | null;
  tolerancePct: number;
}

/**
 * The one place a resolved axis + amount turns into an actual extrinsic-param
 * object -- this flow's equivalent of use-stake-flow.ts's buildStakeCallParams
 * fund-safety-critical seam. Never throws: any malformed/incomplete input
 * (an unparseable amount, a still-loading spot price) resolves to null rather
 * than crashing mid-render, since this is called on every render while the
 * user is still typing/picking.
 *
 * limitPrice direction for axis "subnet": computeLimitPrice's "remove"
 * direction (spot price MINUS tolerance -- "willing to accept down to this
 * much"), against the ORIGIN netuid's spot price. A cross-subnet swap gives
 * up origin-subnet alpha value to receive destination-subnet alpha -- the
 * origin leg is where an adverse price move actually costs the user value,
 * the same case computeLimitPrice's "remove" direction protects against for
 * use-stake-flow.ts's own remove_stake_limit path.
 */
export function buildMoveStakeCallParams(
  input: BuildMoveStakeCallParamsInput,
): MoveStakeParams | SwapStakeLimitParams | null {
  const {
    axis,
    originHotkey,
    originNetuid,
    destinationHotkey,
    destinationNetuid,
    alphaAmountInput,
    originSpotPriceTao,
    tolerancePct,
  } = input;
  try {
    const alphaAmount = alphaToRawAlpha(alphaAmountInput);
    if (alphaAmount <= 0n) return null;

    if (axis === "hotkey") {
      return buildMoveStakeParams({
        originHotkey,
        destinationHotkey,
        netuid: originNetuid,
        alphaAmount,
      });
    }

    if (originSpotPriceTao == null) return null;
    const limitPrice = computeLimitPrice({
      spotPriceTao: originSpotPriceTao,
      tolerancePct,
      direction: "remove",
    });
    return buildSwapStakeLimitParams({
      hotkey: originHotkey,
      originNetuid,
      destinationNetuid,
      alphaAmount,
      limitPrice,
      allowPartial: false,
    });
  } catch {
    return null;
  }
}

export interface UseMoveStakeFlowResult {
  phase: MoveStakeFlowPhase;
  wallet: ReturnType<typeof useWallet>;

  originHotkey: string;
  originNetuid: number;

  destinationHotkeyInput: string;
  setDestinationHotkeyInput: (value: string) => void;
  destinationNetuidInput: string;
  setDestinationNetuidInput: (value: string) => void;
  amountInput: string;
  setAmountInput: (value: string) => void;
  tolerancePct: number;
  setTolerancePct: (value: number) => void;

  axis: MoveStakeAxis | "unchanged" | "both";
  axisIssueMessage: string | null;

  /** TAO per alpha for the ORIGIN subnet, derived from the position data the caller passed in -- null only for a real data gap (a non-root position with an unresolved price). */
  originSpotPriceTao: number | null;

  knownSubnets: Subnet[];

  quote: SubnetStakeQuote | null;
  quoteIsPending: boolean;
  quoteError: string | null;

  maxAmountInput: string | null;
  applyMax: () => void;

  params: MoveStakeParams | SwapStakeLimitParams | null;
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

/** #5244's composition seam for one origin (hotkey, netuid) position's move/re-delegate flow. */
export function useMoveStakeFlow(
  originHotkey: string,
  originNetuid: number,
  positionAlpha: number | null,
  positionSpotTao: number,
): UseMoveStakeFlowResult {
  const wallet = useWallet();
  const txStatus = useTxStatus();
  const isRoot = originNetuid === 0;

  const [destinationHotkeyInput, setDestinationHotkeyInput] = useState(originHotkey);
  const [destinationNetuidInput, setDestinationNetuidInput] = useState(String(originNetuid));
  const [amountInput, setAmountInput] = useState("");
  const [tolerancePct, setTolerancePct] = useState(DEFAULT_TOLERANCE_PCT);
  const [confirmed, setConfirmed] = useState(false);

  // Generated client-only -- see use-stake-flow.ts's identical pattern for
  // why (avoids an SSR/CSR hydration mismatch).
  const [sessionId, setSessionId] = useState("");
  useEffect(() => {
    setSessionId(crypto.randomUUID());
  }, []);

  const [api, setApi] = useState<ApiPromise | null>(null);
  useEffect(() => {
    if (wallet.status !== "connected") return;
    let cancelled = false;
    getApi()
      .then((connected) => {
        if (!cancelled) setApi(connected);
      })
      .catch(() => {
        /* best-effort; minStake/submit simply stay unavailable */
      });
    return () => {
      cancelled = true;
    };
  }, [wallet.status]);

  const [minStakeRao, setMinStakeRao] = useState<Rao | null>(null);
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    getMinStake(api)
      .then((min) => {
        if (!cancelled) setMinStakeRao(min);
      })
      .catch(() => {
        /* best-effort; the min-stake validation issue just stays unavailable */
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const subnetsQ = useQuery(subnetsQuery());
  const knownSubnets = useMemo(
    () => (subnetsQ.data?.data ?? []).slice().sort((a, b) => a.netuid - b.netuid),
    [subnetsQ.data],
  );
  const knownNetuids = useMemo(() => knownSubnets.map((s) => s.netuid), [knownSubnets]);

  const destinationHotkey = destinationHotkeyInput.trim();
  const destinationNetuid = Number(destinationNetuidInput);
  const destinationNetuidValid = Number.isFinite(destinationNetuid);

  const axis = useMemo(() => {
    if (!destinationNetuidValid) return "unchanged" as const;
    return resolveMoveStakeAxis(originHotkey, originNetuid, destinationHotkey, destinationNetuid);
  }, [originHotkey, originNetuid, destinationHotkey, destinationNetuid, destinationNetuidValid]);

  const axisIssueMessage =
    axis === "unchanged" || axis === "both" ? describeMoveStakeAxisIssue(axis) : null;

  const originSpotPriceTao = resolveOriginSpotPriceTao(isRoot, positionAlpha, positionSpotTao);

  const hasValidAmountInput =
    amountInput.trim() !== "" && Number.isFinite(Number(amountInput)) && Number(amountInput) > 0;

  const quoteQ = useQuery({
    ...subnetStakeQuoteQuery(
      originNetuid,
      hasValidAmountInput ? Number(amountInput) : 0,
      "unstake",
    ),
    enabled: axis === "subnet" && hasValidAmountInput,
  });
  const quote = axis === "subnet" ? (quoteQ.data?.data ?? null) : null;

  const params = useMemo(() => {
    if (axis !== "hotkey" && axis !== "subnet") return null;
    if (!hasValidAmountInput) return null;
    return buildMoveStakeCallParams({
      axis,
      originHotkey,
      originNetuid,
      destinationHotkey,
      destinationNetuid,
      alphaAmountInput: amountInput,
      originSpotPriceTao,
      tolerancePct,
    });
  }, [
    axis,
    hasValidAmountInput,
    originHotkey,
    originNetuid,
    destinationHotkey,
    destinationNetuid,
    amountInput,
    originSpotPriceTao,
    tolerancePct,
  ]);

  const validationIssues = useMemo(() => {
    if (!params || minStakeRao == null) return [];
    // Skip the floor/self-consistency pre-check (rather than fabricating a
    // zero-price estimate that would falsely read as "amount_not_positive")
    // when the origin price isn't resolved yet -- this is a UX convenience,
    // not the safety boundary (validateStakeInputs' own doc comment): the
    // chain re-validates and remains authoritative either way.
    if (!isRoot && originSpotPriceTao == null) return [];
    return validateStakeInputs({
      hotkey: destinationHotkey,
      netuid: destinationNetuid,
      knownNetuids,
      amountRao: taoToRao(((Number(amountInput) || 0) * (originSpotPriceTao ?? 1)).toFixed(9)),
      minStakeRao,
      // No availableBalanceRao: a move/swap draws from existing stake, never the free balance.
    });
  }, [
    params,
    minStakeRao,
    isRoot,
    destinationHotkey,
    destinationNetuid,
    knownNetuids,
    amountInput,
    originSpotPriceTao,
  ]);

  const validationMessages = useMemo(
    () => validationIssues.map(describeStakeValidationIssue),
    [validationIssues],
  );

  const canConfirm =
    params != null &&
    validationIssues.length === 0 &&
    originSpotPriceTao != null &&
    (axis !== "subnet" || (quoteQ.isSuccess && !quoteQ.isFetching));

  const maxAmountInput = resolveMoveStakeMaxAmountInput(isRoot, positionAlpha, positionSpotTao);
  const applyMax = useCallback(() => {
    if (maxAmountInput != null) setAmountInput(maxAmountInput);
  }, [maxAmountInput]);

  // Fee dry-run for the PreSignConfirmation screen -- identical posture to
  // use-stake-flow.ts's: only fetched once the user has reached "confirm"
  // with a resolved, idle tx.
  const [feeRao, setFeeRao] = useState<Rao | null>(null);
  useEffect(() => {
    setFeeRao(null);
    if (!confirmed || txStatus.status !== "idle") return;
    if (!api || !wallet.wallet || !params) return;
    let cancelled = false;
    const extrinsic = buildExtrinsic(api, params);
    estimateFee(extrinsic, wallet.wallet.address)
      .then((fee) => {
        if (!cancelled) setFeeRao(fee);
      })
      .catch(() => {
        /* best-effort; the confirm screen just keeps showing "Estimating..." */
      });
    return () => {
      cancelled = true;
    };
  }, [confirmed, txStatus.status, api, wallet.wallet, params]);

  const confirm = useCallback(() => setConfirmed(true), []);
  const editAmount = useCallback(() => {
    setConfirmed(false);
    txStatus.reset();
  }, [txStatus]);

  const close = useCallback(() => {
    txStatus.reset();
    setConfirmed(false);
    setAmountInput("");
    setDestinationHotkeyInput(originHotkey);
    setDestinationNetuidInput(String(originNetuid));
  }, [txStatus, originHotkey, originNetuid]);

  const submit = useCallback(async () => {
    if (!api || !wallet.wallet || !params) return;
    const nonce = await getNextNonce(api, wallet.wallet.address);
    const idempotencyKey = computeIdempotencyKey(params, nonce, sessionId);
    const extrinsic = buildExtrinsic(api, params);
    const signer = await getSigner(wallet.wallet.source);
    await txStatus.submit(api, extrinsic, {
      signerAddress: wallet.wallet.address,
      signer,
      idempotencyKey,
    });
  }, [api, wallet.wallet, params, sessionId, txStatus]);

  const phase = deriveMoveStakeFlowPhase(wallet.status, confirmed, txStatus.status);

  return {
    phase,
    wallet,
    originHotkey,
    originNetuid,
    destinationHotkeyInput,
    setDestinationHotkeyInput,
    destinationNetuidInput,
    setDestinationNetuidInput,
    amountInput,
    setAmountInput,
    tolerancePct,
    setTolerancePct,
    axis,
    axisIssueMessage,
    originSpotPriceTao,
    knownSubnets,
    quote,
    quoteIsPending: quoteQ.isPending,
    quoteError: quoteQ.isError
      ? quoteQ.error instanceof Error
        ? quoteQ.error.message
        : "Could not compute a quote."
      : null,
    maxAmountInput,
    applyMax,
    params,
    feeTao: feeRao != null ? raoToTao(feeRao) : null,
    validationIssues,
    validationMessages,
    canConfirm,
    confirm,
    editAmount,
    txStatus,
    submit,
    canClose: canCloseMoveStakeFlow(txStatus.status),
    close,
  };
}

/** The confirm screen's alpha display -- the exact RawAlpha this params object will submit, never a re-derived estimate. */
export function confirmAlphaAmount(
  params: MoveStakeParams | SwapStakeLimitParams | null,
): string | undefined {
  return params ? rawAlphaToAlpha(params.alphaAmount) : undefined;
}
