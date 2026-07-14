import { useCallback, useRef, useState } from "react";
import type { ApiPromise } from "@polkadot/api";
import type { SubmittableExtrinsic } from "@polkadot/api/types";
import type { Signer } from "@polkadot/api/types";
import {
  submitStakeExtrinsic,
  type BroadcastEvent,
  type BroadcastStatus,
} from "@/lib/metagraphed/broadcast";
import {
  decodeModuleError,
  decodeCustomTxError,
  type DecodedTxError,
} from "@/lib/metagraphed/tx-errors";

/**
 * UI-facing transaction status (#5240), layering on top of broadcast.ts's raw
 * BroadcastStatus: `"failed"` is a status broadcast.ts doesn't have on its
 * own -- an extrinsic that reaches in-block/finalized carrying a
 * dispatchError is still, from the CHAIN's perspective, a successful
 * transaction (mined, fee paid) -- but from the USER's perspective, their
 * stake/unstake/move did not happen, which is what this status communicates.
 */
export type TxUiStatus = "idle" | "signing" | BroadcastStatus | "failed" | "submit-error";

export interface UseTxStatusResult {
  status: TxUiStatus;
  txHash: string | null;
  blockHash: string | null;
  /** Set only when status is "failed" (on-chain module error) or "submit-error" (rejected before/without reaching a block, e.g. a Custom(N) tx-pool code or the extension declining to sign). */
  error: DecodedTxError | null;
  submit: (
    api: ApiPromise,
    extrinsic: SubmittableExtrinsic<"promise">,
    options: { signerAddress: string; signer: Signer; idempotencyKey: string },
  ) => Promise<void>;
  reset: () => void;
}

/**
 * A Custom(N) tx-pool rejection surfaces as a thrown JS Error, not a status
 * callback -- signAndSend's promise itself rejects. polkadot.js's RPC layer
 * formats this as a message containing "Custom error: N" (best-effort parse,
 * not verified against a live rejection -- no way to trigger a real one
 * without actually submitting to a live chain; falls back to a generic
 * decode if the shape doesn't match, never throws itself).
 */
export function parseSubmitError(error: unknown): DecodedTxError {
  const message = error instanceof Error ? error.message : String(error);
  const match = /Custom error:\s*(\d+)/i.exec(message);
  if (match) {
    return decodeCustomTxError(Number(match[1]));
  }
  return {
    category: "unknown",
    message: message || "Failed to submit the transaction.",
    source: "submit",
  };
}

export function useTxStatus(): UseTxStatusResult {
  const [status, setStatus] = useState<TxUiStatus>("idle");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [blockHash, setBlockHash] = useState<string | null>(null);
  const [error, setError] = useState<DecodedTxError | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  const reset = useCallback(() => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    setStatus("idle");
    setTxHash(null);
    setBlockHash(null);
    setError(null);
  }, []);

  const submit = useCallback(
    async (
      api: ApiPromise,
      extrinsic: SubmittableExtrinsic<"promise">,
      options: { signerAddress: string; signer: Signer; idempotencyKey: string },
    ) => {
      setStatus("signing");
      setError(null);
      try {
        const { unsubscribe } = await submitStakeExtrinsic(api, extrinsic, {
          ...options,
          onStatus: (event: BroadcastEvent) => {
            setTxHash(event.txHash);
            if (event.blockHash) setBlockHash(event.blockHash);

            if (event.dispatchError) {
              const decoded = event.dispatchError.isModule
                ? (() => {
                    const meta = api.registry.findMetaError(event.dispatchError!.asModule);
                    return decodeModuleError(meta.section, meta.name);
                  })()
                : {
                    category: "unknown" as const,
                    message: "Transaction failed on-chain.",
                    source: "dispatchError",
                  };
              setError(decoded);
              setStatus("failed");
              return;
            }

            setStatus(event.status);
          },
        });
        unsubscribeRef.current = unsubscribe;
      } catch (err) {
        setError(parseSubmitError(err));
        setStatus("submit-error");
      }
    },
    [],
  );

  return { status, txHash, blockHash, error, submit, reset };
}
