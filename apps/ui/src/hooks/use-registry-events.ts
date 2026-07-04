import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getApiBase, getNetwork, onApiBaseChange, onNetworkChange } from "@/lib/metagraphed/config";

/**
 * #1117: subscribe to the registry publish feed (`GET /api/v1/events`, SSE) and
 * invalidate active queries on each `snapshot` event, so views update on publish
 * instead of only on the next poll. Invalidating the `["metagraphed"]` root marks
 * everything stale but — with the default `refetchType: "active"` — only refetches
 * the queries currently mounted on the calling route, so it's effectively scoped.
 *
 * Complementary to polling, not a replacement: the feed fires on registry PUBLISH,
 * while live tiers (e.g. /api/v1/health) refresh on their own probe cadence, so the
 * existing `refetchInterval`s stay as the fallback. If SSE is unavailable, on
 * testnet, or during SSR, this is a no-op and polling alone drives refreshes.
 *
 * The feed replays the last snapshot immediately on connect; that first event is
 * skipped so we don't refetch data the route just loaded. Re-subscribes when the
 * chain network or API base changes, and tears the EventSource down on unmount.
 */
export function useRegistryEvents() {
  const qc = useQueryClient();
  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;

    let es: EventSource | null = null;
    let primed = false;

    const teardown = () => {
      es?.close();
      es = null;
    };

    const connect = () => {
      teardown();
      // The publish feed is mainnet-only; on testnet, polling remains the path.
      if (getNetwork().id !== "mainnet") return;
      primed = false;
      try {
        es = new EventSource(`${getApiBase()}/api/v1/events`);
      } catch {
        es = null;
        return;
      }
      const onSnapshot = () => {
        // Skip the snapshot replayed on connect (the route already has it); every
        // later event is a real publish worth refreshing for.
        if (!primed) {
          primed = true;
          return;
        }
        qc.invalidateQueries({ queryKey: ["metagraphed"] });
      };
      es.addEventListener("snapshot", onSnapshot);
      // Some proxies deliver SSE as unnamed `message` events — cover both.
      es.onmessage = onSnapshot;
      // onerror: EventSource auto-reconnects; polling covers the gap meanwhile.
    };

    connect();
    const offNetwork = onNetworkChange(connect);
    const offApiBase = onApiBaseChange(connect);
    return () => {
      offNetwork();
      offApiBase();
      teardown();
    };
  }, [qc]);
}
