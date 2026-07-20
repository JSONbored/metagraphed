import { useEffect, useRef, useState } from "react";
import { applyNetworkPrefix } from "@/lib/metagraphed/client";
import { getApiBase, onApiBaseChange, onNetworkChange } from "@/lib/metagraphed/config";
import type { SseStatus } from "@/hooks/use-registry-events";

export type { SseStatus };

/** Tables the chain firehose can filter on via `?topics=` (#4980 / ADR 0015). */
export const CHAIN_FIREHOSE_TOPICS = [
  "blocks",
  "extrinsics",
  "chain_events",
  "account_events",
] as const;

export type ChainFirehoseTopic = (typeof CHAIN_FIREHOSE_TOPICS)[number];

/**
 * Build the absolute EventSource URL for `GET /api/v1/chain/stream`, applying
 * the selected network prefix and optional comma-separated `topics` filter
 * (same contract as `parseChainFirehoseTopics` / `chainFirehoseMatchesTopics`
 * in `workers/chain-firehose-hub.mjs`).
 */
export function buildChainStreamUrl(topics?: readonly string[]): string {
  const base = getApiBase().replace(/\/$/, "");
  const path = applyNetworkPrefix("/api/v1/chain/stream");
  const url = new URL(`${base}${path}`);
  const cleaned = (topics ?? [])
    .map((t) => t.trim())
    .filter((t) => (CHAIN_FIREHOSE_TOPICS as readonly string[]).includes(t));
  if (cleaned.length > 0) url.searchParams.set("topics", cleaned.join(","));
  return url.toString();
}

/**
 * True when a firehose `chain` payload should refresh the filtered
 * `/api/v1/chain-events` feed. Unfiltered feeds always match; with a pallet
 * (and optional method) set, only matching `chain_events` rows qualify.
 */
export function chainStreamEventMatchesFilters(
  payload: unknown,
  pallet: string,
  method: string,
): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const row = payload as Record<string, unknown>;
  if (row.table != null && row.table !== "chain_events") return false;
  const p = pallet.trim();
  const m = method.trim();
  if (!p) return true;
  if (String(row.pallet ?? "") !== p) return false;
  if (m && String(row.method ?? "") !== m) return false;
  return true;
}

/** Pure debounce helper; exported for unit tests. */
export function createDebouncedHandler(run: () => void, waitMs: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer != null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      run();
    }, waitMs);
  };
}

/** Parse an SSE MessageEvent's `data` as JSON; null on empty/malformed. */
export function parseChainStreamPayload(data: unknown): unknown | null {
  if (typeof data !== "string" || data.length === 0) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export interface UseChainStreamOptions {
  /** Topic filter forwarded as `?topics=`. Defaults to `chain_events`. */
  topics?: readonly string[];
  /** When false, stay idle (no socket). */
  enabled?: boolean;
  /** Called (debounced) for each matching `event: chain` frame. */
  onEvent?: (payload: unknown) => void;
  /**
   * Optional client-side filter before `onEvent`. Defaults to accepting every
   * frame the server already topic-filtered.
   */
  matches?: (payload: unknown) => boolean;
  /** Coalesce burst fanout from a busy block. Default 400ms. */
  debounceMs?: number;
}

/**
 * #7008: subscribe to the live chain firehose (`GET /api/v1/chain/stream`,
 * ADR 0015) the same way `useRegistryEvents` opens `/api/v1/events`.
 *
 * Complementary to polling/manual refresh, not a replacement: EventSource
 * auto-reconnects on error, and callers keep their existing refetch path as
 * the gap-cover. Re-subscribes when the chain network or API base changes;
 * tears down on unmount.
 *
 * Returns live `status` + `lastEventAt` for an optional liveness chip.
 */
export function useChainStream(options: UseChainStreamOptions = {}): {
  status: SseStatus;
  lastEventAt: string | null;
} {
  const { topics = ["chain_events"], enabled = true, onEvent, matches, debounceMs = 400 } = options;
  const [status, setStatus] = useState<SseStatus>("idle");
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);

  const onEventRef = useRef(onEvent);
  const matchesRef = useRef(matches);
  onEventRef.current = onEvent;
  matchesRef.current = matches;

  // Serialize topics for a stable effect dep without requiring callers to
  // memoize the array literal.
  const topicsKey = topics.join(",");

  useEffect(() => {
    if (!enabled || typeof window === "undefined" || typeof EventSource === "undefined") {
      return;
    }

    let es: EventSource | null = null;
    let cancelled = false;
    const set = (s: SseStatus) => {
      if (!cancelled) setStatus(s);
    };

    const teardown = () => {
      es?.close();
      es = null;
    };

    const topicList = topicsKey
      ? topicsKey.split(",").filter(Boolean)
      : (["chain_events"] as string[]);

    const connect = () => {
      teardown();
      set("connecting");
      try {
        es = new EventSource(buildChainStreamUrl(topicList));
      } catch {
        es = null;
        set("error");
        return;
      }

      let pending: unknown = null;
      const flush = createDebouncedHandler(() => {
        if (pending === null || cancelled) return;
        const payload = pending;
        pending = null;
        onEventRef.current?.(payload);
      }, debounceMs);

      const handle = (ev: Event) => {
        if (cancelled) return;
        const payload = parseChainStreamPayload((ev as MessageEvent).data);
        if (payload == null) return;
        const match = matchesRef.current;
        if (match && !match(payload)) return;
        if (!cancelled) setLastEventAt(new Date().toISOString());
        pending = payload;
        flush();
      };

      es.addEventListener("chain", handle);
      // Some proxies strip named SSE events into unnamed `message` frames.
      es.onmessage = handle;
      es.addEventListener("open", () => set("open"));
      // onerror: EventSource auto-reconnects; polling/manual refresh covers the gap.
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
  }, [enabled, topicsKey, debounceMs]);

  return { status, lastEventAt };
}
