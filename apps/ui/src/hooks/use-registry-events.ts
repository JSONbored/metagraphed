import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getApiBase, getNetwork, onApiBaseChange, onNetworkChange } from "@/lib/metagraphed/config";

/** Live connection state of the registry publish stream. */
export type SseStatus = "idle" | "connecting" | "open" | "error" | "closed";

/** Pure connect-replay guard; exported for unit tests. */
export function createRegistrySnapshotHandler(invalidate: () => void): () => void {
  let primed = false;
  return () => {
    if (!primed) {
      primed = true;
      return;
    }
    invalidate();
  };
}

/**
 * #1117 / #3436: the single registry-event SSE subscription. Subscribes to the
 * registry publish feed (`GET /api/v1/events`, SSE) and invalidates active queries
 * on each `snapshot` event, so views update on publish instead of only on the next
 * poll. Invalidating the `["metagraphed"]` root marks everything stale but — with
 * the default `refetchType: "active"` — only refetches the queries currently mounted
 * on the calling route, so it's effectively scoped.
 *
 * Complementary to polling, not a replacement: the feed fires on registry PUBLISH,
 * while live tiers (e.g. /api/v1/health) refresh on their own probe cadence, so the
 * existing `refetchInterval`s stay as the fallback. If SSE is unavailable, on
 * testnet, or during SSR, this is a no-op and polling alone drives refreshes.
 *
 * The feed replays the last snapshot immediately on connect; that first event is
 * skipped so we don't refetch data the route just loaded. Re-subscribes when the
 * chain network or API base changes, and tears the EventSource down on unmount.
 *
 * Returns the live connection `status` and `lastEventAt` for optional consumers
 * (e.g. a liveness indicator); callers that only want the side effect can ignore it.
 */
export function useRegistryEvents(): { status: SseStatus; lastEventAt: string | null } {
  const qc = useQueryClient();
  const [status, setStatus] = useState<SseStatus>("idle");
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;

    let es: EventSource | null = null;
    let cancelled = false;
    const set = (s: SseStatus) => {
      if (!cancelled) setStatus(s);
    };

    const teardown = () => {
      es?.close();
      es = null;
    };

    const connect = () => {
      teardown();
      // The publish feed is mainnet-only; on testnet, polling remains the path.
      if (getNetwork().id !== "mainnet") {
        set("idle");
        return;
      }
      set("connecting");
      try {
        es = new EventSource(`${getApiBase()}/api/v1/events`);
      } catch {
        es = null;
        set("error");
        return;
      }
      const onSnapshot = createRegistrySnapshotHandler(() => {
        qc.invalidateQueries({ queryKey: ["metagraphed"] });
      });
      const handle = () => {
        if (!cancelled) setLastEventAt(new Date().toISOString());
        onSnapshot();
      };
      es.addEventListener("snapshot", handle);
      // Some proxies deliver SSE as unnamed `message` events — cover both.
      es.onmessage = handle;
      es.addEventListener("open", () => set("open"));
      // onerror: EventSource auto-reconnects; polling covers the gap meanwhile.
      es.addEventListener("error", () => set("error"));
    };

    connect();
    const offNetwork = onNetworkChange(connect);
    const offApiBase = onApiBaseChange(connect);
    return () => {
      cancelled = true;
      offNetwork();
      offApiBase();
      teardown();
    };
  }, [qc]);

  return { status, lastEventAt };
}
