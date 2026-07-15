// The composition seam for the take-management modal (#5246, native-staking
// epic #5229). Mirrors use-stake-flow.ts's structure and conventions closely
// -- same phase-derivation pattern, same SSR-safe session id, same
// exported-pure-function testing convention -- but is considerably simpler:
// take is a single network-wide percentage, not a two-unit AMM-quoted
// amount, so there's no quote/spot-price/candidate-conversion machinery
// here at all.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiPromise } from "@polkadot/api";
import { useWallet } from "./use-wallet";
import { useTxStatus, type TxUiStatus, type UseTxStatusResult } from "./use-tx-status";
import { raoToTao, type Rao } from "@/lib/metagraphed/units";
import {
  percentToTakeParts,
  takePartsToPercent,
  delegateTakeCooldownRemainingBlocks,
  formatCooldownDuration,
  buildIncreaseTakeParams,
  buildDecreaseTakeParams,
  validateTakeInputs,
  describeTakeValidationIssue,
  type TakeDirection,
  type IncreaseTakeParams,
  type DecreaseTakeParams,
  type TakeValidationIssue,
} from "@/lib/metagraphed/take-extrinsics";
import {
  getApi,
  getCurrentBlock,
  getMaxDelegateTake,
  getMinDelegateTake,
  getTxDelegateTakeRateLimit,
  getCurrentTakeParts,
  getLastTxBlockDelegateTake,
  getNextNonce,
  buildExtrinsic,
} from "@/lib/metagraphed/chain-connection";
import { getSigner } from "@/lib/metagraphed/wallet-injected";
import { computeIdempotencyKey } from "@/lib/metagraphed/broadcast";
import { estimateFee } from "@/lib/metagraphed/tx-fee";

export type TakeFlowPhase =
  "connect" | "amount" | "confirm" | "signing" | "broadcasting" | "failed" | "done";

/** Identical shape to deriveStakeFlowPhase (use-stake-flow.ts) -- see that function's doc comment for the phase-transition rationale, unchanged here. */
export function deriveTakeFlowPhase(
  walletStatus: string,
  confirmed: boolean,
  txStatus: TxUiStatus,
): TakeFlowPhase {
  if (walletStatus !== "connected") return "connect";
  if (!confirmed) return "amount";
  if (txStatus === "idle") return "confirm";
  if (txStatus === "signing") return "signing";
  if (txStatus === "failed" || txStatus === "submit-error") return "failed";
  if (txStatus === "finalized") return "done";
  return "broadcasting";
}

/** Identical to canCloseStakeFlow (use-stake-flow.ts). */
export function canCloseTakeFlow(txStatus: TxUiStatus): boolean {
  return (
    txStatus === "idle" ||
    txStatus === "failed" ||
    txStatus === "submit-error" ||
    txStatus === "finalized"
  );
}

interface TakeBounds {
  maxTakeParts: number;
  minTakeParts: number;
  rateLimitBlocks: number;
  currentTakeParts: number;
  lastTxBlock: number;
  currentBlock: number;
}

export interface UseTakeFlowResult {
  phase: TakeFlowPhase;
  wallet: ReturnType<typeof useWallet>;
  /** Whether the connected wallet is this hotkey's owning coldkey -- the pallet's own NonAssociatedColdKey check, mirrored client-side. */
  isOwner: boolean;

  direction: TakeDirection;
  setDirection: (direction: TakeDirection) => void;
  percentInput: string;
  setPercentInput: (value: string) => void;

  currentTakePct: number | null;
  minTakePct: number | null;
  maxTakePct: number | null;
  /** Only ever nonzero for "increase" -- decrease_take has no rate limit at all (see take-extrinsics.ts's header comment). */
  cooldownRemainingBlocks: number;
  cooldownDurationLabel: string | null;

  params: IncreaseTakeParams | DecreaseTakeParams | null;
  feeTao: string | null;
  validationIssues: TakeValidationIssue[];
  validationMessages: string[];
  canConfirm: boolean;
  confirm: () => void;
  editAmount: () => void;

  txStatus: UseTxStatusResult;
  submit: () => Promise<void>;
  canClose: boolean;
  close: () => void;
}

/** #5246's composition seam for one hotkey's take-management flow. `ownerColdkey` is the validator-detail API's reported owning coldkey -- re-compared against the LIVE connected wallet address on every render, not frozen at mount, since the user could switch accounts in their extension mid-session. */
export function useTakeFlow(hotkey: string, ownerColdkey: string | null): UseTakeFlowResult {
  const wallet = useWallet();
  const txStatus = useTxStatus();

  const [direction, setDirection] = useState<TakeDirection>("increase");
  const [percentInput, setPercentInput] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  const isOwner = !!ownerColdkey && wallet.wallet?.address === ownerColdkey;

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
        /* best-effort; bounds/submit simply stay unavailable */
      });
    return () => {
      cancelled = true;
    };
  }, [wallet.status]);

  const [bounds, setBounds] = useState<TakeBounds | null>(null);
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    Promise.all([
      getMaxDelegateTake(api),
      getMinDelegateTake(api),
      getTxDelegateTakeRateLimit(api),
      getCurrentTakeParts(api, hotkey),
      getLastTxBlockDelegateTake(api, hotkey),
      getCurrentBlock(api),
    ])
      .then(
        ([
          maxTakeParts,
          minTakeParts,
          rateLimitBlocks,
          currentTakeParts,
          lastTxBlock,
          currentBlock,
        ]) => {
          if (!cancelled) {
            setBounds({
              maxTakeParts,
              minTakeParts,
              rateLimitBlocks,
              currentTakeParts,
              lastTxBlock,
              currentBlock,
            });
          }
        },
      )
      .catch(() => {
        /* best-effort; Max/bounds-derived validation issues just stay unavailable */
      });
    return () => {
      cancelled = true;
    };
  }, [api, hotkey]);

  const hasValidPercentInput = percentInput.trim() !== "" && Number.isFinite(Number(percentInput));

  const params = useMemo(() => {
    if (!hasValidPercentInput) return null;
    try {
      const take = percentToTakeParts(Number(percentInput));
      return direction === "increase"
        ? buildIncreaseTakeParams({ hotkey, take })
        : buildDecreaseTakeParams({ hotkey, take });
    } catch {
      return null;
    }
  }, [hasValidPercentInput, percentInput, direction, hotkey]);

  const cooldownRemainingBlocks = bounds
    ? delegateTakeCooldownRemainingBlocks(
        bounds.lastTxBlock,
        bounds.currentBlock,
        bounds.rateLimitBlocks,
      )
    : 0;

  const validationIssues = useMemo(() => {
    if (!params || !bounds) return [];
    return validateTakeInputs({
      hotkey,
      isOwner,
      direction,
      takeParts: params.take,
      currentTakeParts: bounds.currentTakeParts,
      minTakeParts: bounds.minTakeParts,
      maxTakeParts: bounds.maxTakeParts,
      cooldownRemainingBlocks,
    });
  }, [params, bounds, hotkey, isOwner, direction, cooldownRemainingBlocks]);

  const validationMessages = useMemo(
    () => validationIssues.map(describeTakeValidationIssue),
    [validationIssues],
  );

  const canConfirm = params != null && bounds != null && validationIssues.length === 0;

  // Fee dry-run -- identical posture to use-stake-flow.ts's: only fetched
  // once the user has reached "confirm" with a resolved, idle tx.
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
    setPercentInput("");
  }, [txStatus]);

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

  const phase = deriveTakeFlowPhase(wallet.status, confirmed, txStatus.status);

  return {
    phase,
    wallet,
    isOwner,
    direction,
    setDirection,
    percentInput,
    setPercentInput,
    currentTakePct: bounds ? takePartsToPercent(bounds.currentTakeParts) : null,
    minTakePct: bounds ? takePartsToPercent(bounds.minTakeParts) : null,
    maxTakePct: bounds ? takePartsToPercent(bounds.maxTakeParts) : null,
    cooldownRemainingBlocks,
    cooldownDurationLabel:
      cooldownRemainingBlocks > 0 ? formatCooldownDuration(cooldownRemainingBlocks) : null,
    params,
    feeTao: feeRao != null ? raoToTao(feeRao) : null,
    validationIssues,
    validationMessages,
    canConfirm,
    confirm,
    editAmount,
    txStatus,
    submit,
    canClose: canCloseTakeFlow(txStatus.status),
    close,
  };
}
