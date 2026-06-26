import { useEffect, useState } from "react";
import { useApiBase } from "./use-api-base";

export type EndpointHealth = "checking" | "ok" | "slow" | "bad" | "down";

export interface EndpointHealthState {
  status: EndpointHealth;
  ms: number | null;
}

// Round-trip latency tiers for the footer's API-endpoint health dot.
const SLOW_MS = 300; // ok → slow (yellow)
const BAD_MS = 800; // slow → bad (orange)
const REFRESH_MS = 30_000;

function classify(ms: number | null): EndpointHealth {
  if (ms == null) return "down";
  if (ms > BAD_MS) return "bad";
  if (ms > SLOW_MS) return "slow";
  return "ok";
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
 * Polls the live API origin and buckets round-trip latency into health tiers
 * (ok / slow / bad / down) for the footer pulse-strip dot. Re-checks every 30s
 * and whenever the runtime API base changes. Read-only — mutates no app state.
 */
export function useEndpointHealth(): EndpointHealthState {
  const { base } = useApiBase();
  const [state, setState] = useState<EndpointHealthState>({ status: "checking", ms: null });

  useEffect(() => {
    const url = `${base.replace(/\/$/, "")}/api/v1/coverage`;
    let active = true;
    const controller = new AbortController();

    async function check() {
      const ms = await pingMs(url, controller.signal);
      if (active) setState({ status: classify(ms), ms });
    }

    setState({ status: "checking", ms: null });
    void check();
    const id = window.setInterval(() => void check(), REFRESH_MS);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(id);
    };
  }, [base]);

  return state;
}
