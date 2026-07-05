import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getApiBase,
  setApiBase,
  onApiBaseChange,
  DEFAULT_API_BASE,
  getNetwork,
  setNetwork,
  onNetworkChange,
  DEFAULT_NETWORK,
  type ChainNetwork,
} from "@/lib/metagraphed/config";

/** Query root both runtime hooks invalidate when origin or network changes. */
export const METAGRAPHED_QUERY_ROOT = ["metagraphed"] as const;

export function metagraphedQueryInvalidationTarget() {
  return { queryKey: METAGRAPHED_QUERY_ROOT };
}

export function isDefaultApiBase(base: string): boolean {
  return base === DEFAULT_API_BASE;
}

export function isDefaultChainNetwork(network: ChainNetwork): boolean {
  return network.id === DEFAULT_NETWORK.id;
}

/**
 * Subscribe to the runtime API base. Returns the current value plus a
 * `change()` helper that persists, broadcasts, and invalidates queries
 * so all consumers refetch against the new origin.
 */
export function useApiBase() {
  const [base, setBase] = useState<string>(() => getApiBase());
  const qc = useQueryClient();

  useEffect(() => onApiBaseChange((next) => setBase(next)), []);

  const change = (next: string) => {
    setApiBase(next);
    // Drop everything; we just changed origins.
    qc.invalidateQueries(metagraphedQueryInvalidationTarget());
  };

  return { base, change, isDefault: isDefaultApiBase(base) };
}

/**
 * Subscribe to the selected chain network (mainnet/testnet). `change()` persists
 * the choice and invalidates all queries so the app refetches against the new
 * `/{network}/` data partition on the same API origin.
 */
export function useNetwork() {
  const [network, setNet] = useState<ChainNetwork>(() => getNetwork());
  const qc = useQueryClient();

  useEffect(() => onNetworkChange((next) => setNet(next)), []);

  const change = (id: string) => {
    setNetwork(id);
    qc.invalidateQueries(metagraphedQueryInvalidationTarget());
  };

  return { network, change, isDefault: isDefaultChainNetwork(network) };
}
