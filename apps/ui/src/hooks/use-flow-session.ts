// Shared plumbing for the stake/take signing flows (use-stake-flow.ts,
// use-move-stake-flow.ts, use-take-flow.ts): a client-only session id, the
// getApi() connect effect, and the PreSignConfirmation fee-estimate dry-run
// -- each was previously duplicated near-verbatim across all three hooks
// (#7912). Pure internal dedup: every effect below is byte-for-byte the
// logic each hook already ran inline, just relocated here.

import { useEffect, useState } from "react";
import type { ApiPromise } from "@polkadot/api";
import type { TxUiStatus } from "./use-tx-status";
import type { ConnectedWallet } from "@/lib/metagraphed/wallet";
import { getApi, buildExtrinsic, type StakeCallParams } from "@/lib/metagraphed/chain-connection";
import { estimateFee } from "@/lib/metagraphed/tx-fee";
import type { Rao } from "@/lib/metagraphed/units";

export interface UseFlowSessionResult {
  sessionId: string;
  api: ApiPromise | null;
}

/**
 * A client-only session id (crypto.randomUUID(), generated post-mount to
 * avoid an SSR/CSR hydration mismatch) plus the wallet-gated getApi()
 * connect effect -- every stake/take flow hook needs both, always together,
 * to submit its own extrinsic later.
 */
export function useFlowSession(walletStatus: string): UseFlowSessionResult {
  const [sessionId, setSessionId] = useState("");
  useEffect(() => {
    setSessionId(crypto.randomUUID());
  }, []);

  const [api, setApi] = useState<ApiPromise | null>(null);
  useEffect(() => {
    if (walletStatus !== "connected") return;
    let cancelled = false;
    getApi()
      .then((connected) => {
        if (!cancelled) setApi(connected);
      })
      .catch(() => {
        /* best-effort; callers' own dependent data simply stays unavailable */
      });
    return () => {
      cancelled = true;
    };
  }, [walletStatus]);

  return { sessionId, api };
}

/**
 * The PreSignConfirmation fee dry-run -- identical across all three stake/
 * take flows: only fetched once the user has reached "confirm" with a
 * resolved, idle tx and a buildable params object.
 */
export function useFeeEstimate(
  confirmed: boolean,
  txStatus: TxUiStatus,
  api: ApiPromise | null,
  walletAccount: ConnectedWallet | null,
  params: StakeCallParams | null,
): Rao | null {
  const [feeRao, setFeeRao] = useState<Rao | null>(null);
  useEffect(() => {
    setFeeRao(null);
    if (!confirmed || txStatus !== "idle") return;
    if (!api || !walletAccount || !params) return;
    let cancelled = false;
    const extrinsic = buildExtrinsic(api, params);
    estimateFee(extrinsic, walletAccount.address)
      .then((fee) => {
        if (!cancelled) setFeeRao(fee);
      })
      .catch(() => {
        /* best-effort; the confirm screen just keeps showing "Estimating..." */
      });
    return () => {
      cancelled = true;
    };
  }, [confirmed, txStatus, api, walletAccount, params]);

  return feeRao;
}
