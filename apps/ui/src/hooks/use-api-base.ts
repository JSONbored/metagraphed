import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useHydrated } from "@/hooks/use-hydrated";
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
  const hydrated = useHydrated();

  useEffect(() => onNetworkChange((next) => setNet(next)), []);

  const change = (id: string) => {
    setNetwork(id);
    qc.invalidateQueries(metagraphedQueryInvalidationTarget());
  };

  // #8283: render the SSR-side default until hydration finishes, then switch to
  // the real network. getNetwork() resolves the hostname/localStorage
  // immediately on the client, so without this the first client render emits
  // "Testnet" against server HTML that says "Mainnet" -- and that mismatch is
  // not cosmetic. React responds by discarding the server tree ("this tree will
  // be regenerated on the client"), which strands every in-flight Suspense
  // boundary on the page: on testnet.metagraph.sh the nine SubnetsHighlights /
  // SubnetsStatStrip panels sat on "Loading panel…" forever, never resolving to
  // content OR to NativeOnlyNotice. Proven by bisection -- a client-side
  // navigation to the same route (no hydration pass) settles all nine
  // correctly, a fresh load hangs indefinitely.
  //
  // Deliberately scoped to the RENDERED value only. Data fetching reads
  // getNetwork() directly through applyNetworkPrefix, so queries still target
  // the right network from the very first request; this only defers what the
  // two display-only consumers (the switcher label, the RPC-proxy hero) paint
  // during the single hydration render.
  const rendered = hydrated ? network : DEFAULT_NETWORK;

  return {
    network: rendered,
    change,
    isDefault: isDefaultChainNetwork(rendered),
  };
}
