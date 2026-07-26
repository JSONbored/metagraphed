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
 * in `workers/chain-firehose-hub.ts`).
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

/**
 * Debounced trigger with an out-of-band cancel handle, so a connection
 * teardown can drop a scheduled-but-not-yet-fired flush (#8179).
 */
export interface DebouncedHandler {
  (): void;
  /** Drop the pending, not-yet-fired invocation (if any) without running it. */
  cancel: () => void;
}

/** Pure debounce helper; exported for unit tests. */
export function createDebouncedHandler(run: () => void, waitMs: number): DebouncedHandler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (timer != null) clearTimeout(timer);
    timer = null;
  };
  return Object.assign(
    () => {
      if (timer != null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        run();
      }, waitMs);
    },
    { cancel },
  );
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

/** The slice of `EventSource` the session logic needs; injected for unit tests. */
export interface ChainStreamSource {
  addEventListener(type: string, listener: (ev: Event) => void): void;
  close(): void;
  onmessage: ((ev: MessageEvent) => void) | null;
}

export interface ChainStreamSessionDeps {
  /** Open a fresh source for the current network/API base; may throw. */
  openSource: () => ChainStreamSource;
  /** Read through to the caller's latest `onEvent` (ref-backed in the hook). */
  getOnEvent: () => ((payload: unknown) => void) | undefined;
  /** Read through to the caller's latest `matches` (ref-backed in the hook). */
  getMatches: () => ((payload: unknown) => boolean) | undefined;
  debounceMs: number;
  setStatus: (s: SseStatus) => void;
  /** Called on every accepted frame (feeds `lastEventAt`). */
  markActivity: () => void;
}

/**
 * Connection lifecycle for `useChainStream`, extracted so the reconnect /
 * teardown behavior is unit-testable in this suite's plain-node environment
 * (no jsdom/renderHook -- see `apps/ui/vitest.config.ts`).
 *
 * #8179: `teardown()` cancels the previous connection's pending debounce in
 * addition to closing its source. Without that, a frame received on the old
 * connection could sit in a scheduled `flush()` timer across a
 * network/API-base reconnect and fire *after* the switch, delivering a stale
 * cross-network payload to `onEvent`.
 */
export function createChainStreamSession(deps: ChainStreamSessionDeps): {
  connect: () => void;
  dispose: () => void;
} {
  let es: ChainStreamSource | null = null;
  let disposed = false;
  let cancelPendingFlush: (() => void) | null = null;
  const set = (s: SseStatus) => {
    if (!disposed) deps.setStatus(s);
  };

  const teardown = () => {
    cancelPendingFlush?.();
    cancelPendingFlush = null;
    es?.close();
    es = null;
  };

  const connect = () => {
    teardown();
    set("connecting");
    try {
      es = deps.openSource();
    } catch {
      es = null;
      set("error");
      return;
    }

    let pending: unknown = null;
    const flush = createDebouncedHandler(() => {
      if (pending === null || disposed) return;
      const payload = pending;
      pending = null;
      deps.getOnEvent()?.(payload);
    }, deps.debounceMs);
    cancelPendingFlush = flush.cancel;

    const handle = (ev: Event) => {
      if (disposed) return;
      const payload = parseChainStreamPayload((ev as MessageEvent).data);
      if (payload == null) return;
      const match = deps.getMatches();
      if (match && !match(payload)) return;
      deps.markActivity();
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

  const dispose = () => {
    disposed = true;
    teardown();
  };

  return { connect, dispose };
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

    const topicList = topicsKey
      ? topicsKey.split(",").filter(Boolean)
      : (["chain_events"] as string[]);

    const session = createChainStreamSession({
      openSource: () => new EventSource(buildChainStreamUrl(topicList)),
      getOnEvent: () => onEventRef.current,
      getMatches: () => matchesRef.current,
      debounceMs,
      setStatus,
      markActivity: () => setLastEventAt(new Date().toISOString()),
    });

    session.connect();
    const offNetwork = onNetworkChange(session.connect);
    const offApiBase = onApiBaseChange(session.connect);
    return () => {
      offNetwork();
      offApiBase();
      session.dispose();
    };
  }, [enabled, topicsKey, debounceMs]);

  return { status, lastEventAt };
}
