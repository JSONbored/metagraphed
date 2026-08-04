import { useEffect, useState } from "react";
import { applyNetworkPrefix } from "@/lib/metagraphed/client";
import { useApiBase, useNetwork } from "./use-api-base";

export type EndpointHealth = "checking" | "ok" | "slow" | "bad" | "down";

export interface EndpointHealthState {
  status: EndpointHealth;
  ms: number | null;
}

// Round-trip latency tiers for the footer's API-endpoint health dot.
const SLOW_MS = 300; // ok → slow (yellow)
const BAD_MS = 800; // slow → bad (orange)
const REFRESH_MS = 30_000;

/** Pure latency bucketing for the footer health dot; exported for unit tests. */
export function classifyEndpointLatency(ms: number | null): EndpointHealth {
  if (ms == null) return "down";
  if (ms > BAD_MS) return "bad";
  if (ms > SLOW_MS) return "slow";
  return "ok";
}

/**
 * The URL the footer health dot probes, for the currently selected network.
 *
 * Exported and pure so the network scoping is testable in this suite's plain
 * node environment, mirroring buildChainStreamUrl in use-chain-stream.ts. The
 * bug this guards against is silent: an unprefixed probe still returns 200 and
 * still paints a green dot, it just measures the wrong partition.
 */
export function buildEndpointHealthUrl(base: string): string {
  return `${base.replace(/\/$/, "")}${applyNetworkPrefix("/api/v1/coverage")}`;
}

async function pingMs(url: string, signal: AbortSignal): Promise<number | null> {
  const start = performance.now?.() ?? Date.now();
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal });
    if (!res.ok) return null;
    return Math.round((performance.now?.() ?? Date.now()) - start);
  } catch {
    return null; // network error / abort → treated as down by the caller
  }
}

/**
 * Polls the live API and buckets round-trip latency into health tiers
 * (ok / slow / bad / down) for the footer pulse-strip dot. Re-checks every 30s
 * and whenever the runtime API base or the selected network changes. Read-only
 * — mutates no app state.
 *
 * The probe is network-scoped. This hook predates multi-network addressing and
 * built its URL by hand, so on testnet.metagraph.sh it measured
 * /api/v1/coverage — mainnet's artifact — while every other request on the page
 * went to /api/v1/testnet/*. The dot then reported the latency of a partition
 * the user was not reading, which is worse than no dot: the two artifacts have
 * independent cache states, so a cold testnet read shows green off a warm
 * mainnet one. `/api/v1/coverage` is served on every network, so prefixing it
 * is safe (unlike, say, /api/v1/feeds/watch, which genuinely 404s off mainnet).
 */
export function useEndpointHealth(): EndpointHealthState {
  const { base } = useApiBase();
  // Subscribed, not merely read: applyNetworkPrefix resolves the network at
  // call time, so without this the effect would not re-run when the user
  // switches networks in place and the dot would keep probing the old one.
  const { network } = useNetwork();
  const [state, setState] = useState<EndpointHealthState>({ status: "checking", ms: null });

  useEffect(() => {
    const url = buildEndpointHealthUrl(base);
    let active = true;
    const controller = new AbortController();

    async function check() {
      const ms = await pingMs(url, controller.signal);
      if (active) setState({ status: classifyEndpointLatency(ms), ms });
    }

    setState({ status: "checking", ms: null });
    void check();
    const id = window.setInterval(() => void check(), REFRESH_MS);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(id);
    };
  }, [base, network.id]);

  return state;
}
