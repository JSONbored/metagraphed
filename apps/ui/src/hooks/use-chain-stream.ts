import { useEffect, useRef, useState } from "react";
import { applyNetworkPrefix } from "@/lib/metagraphed/client";
import { getApiBase, onApiBaseChange, onNetworkChange } from "@/lib/metagraphed/config";
import type { SseStatus } from "@/hooks/use-registry-events";
import { usePageVisible } from "@/hooks/use-refetch-interval";

export type { SseStatus };

// #8365: after this many CONSECUTIVE `error` events on one connection
// attempt (no intervening `open`), stop relying on EventSource's own native
// auto-reconnect -- which keeps retrying quickly and indefinitely on its
// own -- and take over reconnect scheduling ourselves on a much longer
// cadence. Without this, a genuinely down/misconfigured endpoint has every
// open tab hammering it in a tight retry loop forever; every consumer
// already has its own polling fallback as the documented gap-cover (see
// each `onEvent` call site's own `invalidateQueries`/`refetch`), so nothing
// downstream depends on the stream itself recovering quickly.
export const CHAIN_STREAM_DOWNGRADE_AFTER_FAILURES = 3;
export const CHAIN_STREAM_DOWNGRADE_RETRY_MS = 5 * 60_000;

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
 * True when a firehose `account_events` payload belongs to the given subnet
 * (#8445). `account_events` rows carry `netuid` directly on the payload
 * (the retired `enqueue_chain_firehose()` trigger), unlike
 * `chain_events`, which doesn't -- so subnet-scoped filtering has to use this
 * topic rather than extending `chainStreamEventMatchesFilters`.
 */
export function accountEventMatchesNetuid(payload: unknown, netuid: number): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const row = payload as Record<string, unknown>;
  if (row.table != null && row.table !== "account_events") return false;
  return Number(row.netuid) === netuid;
}

/**
 * True when a firehose `account_events` payload's `netuid` is one of the
 * given watched subnets (#8446). Membership check (vs. `accountEventMatchesNetuid`'s
 * single value) for the home watchlist module, which flashes whichever
 * watched row an event lands on rather than watching just one subnet.
 */
export function accountEventNetuidIn(payload: unknown, netuids: ReadonlySet<string>): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const row = payload as Record<string, unknown>;
  if (row.table != null && row.table !== "account_events") return false;
  return netuids.has(String(row.netuid));
}

/**
 * True when a firehose `account_events` payload's `hotkey` is one of the
 * given watched validators (#8446).
 */
export function accountEventHotkeyIn(payload: unknown, hotkeys: ReadonlySet<string>): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const row = payload as Record<string, unknown>;
  if (row.table != null && row.table !== "account_events") return false;
  return typeof row.hotkey === "string" && hotkeys.has(row.hotkey);
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
  /**
   * Deliver each accepted frame SYNCHRONOUSLY and uncoalesced, instead of
   * through `debounceMs` + `getOnEvent`.
   *
   * For the shared pool (`acquireSharedChainStream`), where one socket has
   * many subscribers and each does its own debouncing. Coalescing at the
   * socket would be wrong for all of them: `pending = payload` OVERWRITES, so
   * a burst inside one debounce window would silently drop every frame but
   * the last -- correct when a single consumer asked for exactly that, data
   * loss when it is imposed on consumers that did not.
   */
  deliverRaw?: (payload: unknown) => void;
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
  // #8365: consecutive `error` events on the CURRENT connection attempt,
  // reset to 0 by every explicit `connect()` call (mount, network/API-base
  // change, or the downgrade retry below) -- each represents a fresh,
  // deliberate attempt that deserves its own full run at the threshold
  // rather than inheriting an unrelated prior sequence's count.
  let consecutiveFailures = 0;
  let downgradeRetryTimer: ReturnType<typeof setTimeout> | null = null;
  const set = (s: SseStatus) => {
    if (!disposed) deps.setStatus(s);
  };

  const clearDowngradeRetry = () => {
    if (downgradeRetryTimer != null) clearTimeout(downgradeRetryTimer);
    downgradeRetryTimer = null;
  };

  const teardown = () => {
    cancelPendingFlush?.();
    cancelPendingFlush = null;
    clearDowngradeRetry();
    es?.close();
    es = null;
  };

  const connect = () => {
    teardown();
    consecutiveFailures = 0;
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
      if (deps.deliverRaw) {
        deps.deliverRaw(payload);
        return;
      }
      pending = payload;
      flush();
    };

    es.addEventListener("chain", handle);
    // Some proxies strip named SSE events into unnamed `message` frames.
    es.onmessage = handle;
    es.addEventListener("open", () => {
      consecutiveFailures = 0;
      set("open");
    });
    es.addEventListener("error", () => {
      set("error");
      consecutiveFailures += 1;
      if (consecutiveFailures < CHAIN_STREAM_DOWNGRADE_AFTER_FAILURES) {
        // Under the threshold: EventSource's own native auto-reconnect
        // handles this attempt, same as before -- nothing further to do.
        return;
      }
      // At/over the threshold: close explicitly (stopping the native
      // auto-reconnect this same `es` would otherwise keep attempting) and
      // take over on a long, explicit cadence instead. `disposed` is
      // rechecked inside the timer callback, not just guarded by
      // clearDowngradeRetry() at teardown, because dispose()/a fresh
      // connect() elsewhere could race a timer that's already about to fire.
      es?.close();
      es = null;
      downgradeRetryTimer = setTimeout(() => {
        downgradeRetryTimer = null;
        if (!disposed) connect();
      }, CHAIN_STREAM_DOWNGRADE_RETRY_MS);
    });
  };

  const dispose = () => {
    disposed = true;
    teardown();
  };

  return { connect, dispose };
}

/**
 * ONE CONNECTION PER TOPIC SET PER TAB, shared by every consumer of it.
 *
 * ## THE BUG THIS FIXES
 *
 * `useChainStream` opened its own `EventSource` per CALL SITE, and there are
 * six: two in home-watched-module, plus registry-ticker (which lives in the
 * header, so it is on every page), chain-events-feed, live-block-rail and the
 * subnet detail route. Three of them ask for `account_events` and two for
 * `blocks` -- identical URLs, separate sockets.
 *
 * The server caps ONE IP at CHAIN_FIREHOSE_MAX_CONNECTIONS_PER_IP = 20
 * concurrent SSE connections, so a handful of open tabs reaches the cap on its
 * own. Measured 2026-08-12: /api/v1/chain/stream ran at ~95% 5xx for days, and
 * once the cap attribution shipped every refusal came back
 * `chain_firehose_cap_sse_per_ip` -- NOT `:unattributed` and NOT the global
 * cap. The app was refusing itself, and the browser's own reconnect made it
 * look like sustained load.
 *
 * ## WHY SHARING IS SAFE HERE
 *
 * The connection is shared; the PROCESSING is not. The shared session applies
 * no `matches` and no debounce -- each subscriber still runs its own filter,
 * its own debounce and its own `markActivity`, so a consumer sees exactly the
 * frames and the coalescing it would have seen on a private socket. Only the
 * socket is pooled.
 *
 * Keyed on the topic list AND the debounce, because debounce is a property of
 * the delivery a caller asked for; two callers wanting different coalescing
 * still share nothing they should not. In practice every current call site
 * takes the default, so the six collapse to three.
 */
interface ChainStreamSubscriber {
  /**
   * The topics this consumer actually asked for.
   *
   * Needed because the socket now carries the UNION of every consumer's
   * topics, so a `blocks` consumer receives `account_events` frames and has to
   * drop them. The server's own filter is `topics.has(payload.table)`
   * (`chainFirehoseMatchesTopics`); this is the same rule applied on the side
   * that now knows more than the URL says.
   */
  topics: Set<string>;
  getMatches: () => ((payload: unknown) => boolean) | undefined;
  setStatus: (s: SseStatus) => void;
  markActivity: () => void;
  /** This subscriber's OWN debounced hand-off to its `onEvent`. */
  deliver: (payload: unknown) => void;
  /** Cancels a pending `deliver`, so a frame cannot land after release. */
  cancel: () => void;
}

interface SharedChainStream {
  session: { connect: () => void; dispose: () => void };
  subscribers: Set<ChainStreamSubscriber>;
  /** The union of every subscriber's topics. GROW-ONLY -- see acquire. */
  topics: Set<string>;
  /** Last status the socket reported, replayed to a late subscriber so it
   * does not sit at "connecting" for a connection that is already open. */
  status: SseStatus;
  offNetwork: () => void;
  offApiBase: () => void;
}

/**
 * ONE SOCKET PER TAB. Not one per call site, and not one per topic set.
 *
 * ## WHY THIS GOT A SECOND PASS
 *
 * #10952 pooled by topic set, which took a fully-loaded tab from six sockets
 * to three and cut refusals about 75% (measured: ~50-80 per 15 minutes before,
 * 14 after). It did not close the problem, and the arithmetic says why: the
 * server caps ONE IP at CHAIN_FIREHOSE_MAX_CONNECTIONS_PER_IP = 20 concurrent
 * SSE connections, so three sockets a tab still breaks at seven tabs. Every
 * remaining refusal came back `chain_firehose_cap_sse_per_ip` -- the app
 * refusing itself, just less often.
 *
 * One socket a tab makes the same cap mean twenty tabs.
 *
 * ## GROW-ONLY, WHICH IS THE WHOLE TRICK
 *
 * The socket's URL carries the union of its subscribers' topics, and that
 * union NEVER SHRINKS. Shrinking on unmount would reopen the connection on
 * every navigation -- a reconnect storm against a cap on concurrent
 * connections, which is the failure this exists to avoid. Growing is bounded
 * by the topic vocabulary (three values today), so a tab reopens at most
 * twice in its life and then holds one stable connection.
 *
 * A superset subscription is always SAFE because the filter moved to the
 * subscriber: receiving a frame you did not ask for costs one `Set.has` and a
 * discard, while missing one you did ask for would be data loss.
 */
const SHARED_CHAIN_STREAMS = new Map<string, SharedChainStream>();

/** The single pool entry. A constant, so the map holds at most one. */
const SHARED_CHAIN_STREAM_KEY = "chain-stream";

/** Exported for tests: no connection may outlive its last subscriber. */
export function activeSharedChainStreamCount(): number {
  return SHARED_CHAIN_STREAMS.size;
}

/** Exported for tests: what the live socket is currently subscribed to. */
export function sharedChainStreamTopics(): string[] {
  return [...(SHARED_CHAIN_STREAMS.get(SHARED_CHAIN_STREAM_KEY)?.topics ?? [])].sort();
}

/**
 * Join (or open) the tab's chain-stream connection. Returns the release
 * function; the socket closes when the last subscriber releases it.
 */
export function acquireSharedChainStream(
  /**
   * Opens the socket for a given topic union. INJECTED, like
   * `createChainStreamSession`'s own `openSource` and for the same reason:
   * this suite runs in plain node with no `EventSource`, and a pool that could
   * only be exercised in a browser is a pool whose ref-counting nobody checks.
   */
  openSource: (topics: string[]) => ChainStreamSource,
  subscriber: ChainStreamSubscriber,
): () => void {
  const key = SHARED_CHAIN_STREAM_KEY;
  let shared = SHARED_CHAIN_STREAMS.get(key);
  if (!shared) {
    const subscribers = new Set<ChainStreamSubscriber>();
    const entry = {
      subscribers,
      topics: new Set<string>(),
      status: "connecting" as SseStatus,
    } as SharedChainStream;
    const session = createChainStreamSession({
      openSource: () => openSource([...entry.topics].sort()),
      // Every subscriber filters for itself below, both by topic and by its
      // own `matches`.
      getMatches: () => undefined,
      // Unused: `deliverRaw` below takes the frame path instead, so nothing
      // coalesces at the socket.
      debounceMs: 0,
      getOnEvent: () => undefined,
      deliverRaw: (payload: unknown) => {
        const table = (payload as { table?: unknown } | null)?.table;
        for (const sub of subscribers) {
          // The topic filter the URL used to do for us.
          if (!sub.topics.has(table as string)) continue;
          const match = sub.getMatches();
          if (match && !match(payload)) continue;
          sub.markActivity();
          sub.deliver(payload);
        }
      },
      setStatus: (s) => {
        entry.status = s;
        for (const sub of subscribers) sub.setStatus(s);
      },
      markActivity: () => {},
    });
    entry.session = session;
    entry.offNetwork = onNetworkChange(session.connect);
    entry.offApiBase = onApiBaseChange(session.connect);
    SHARED_CHAIN_STREAMS.set(key, entry);
    shared = entry;
  }
  shared.subscribers.add(subscriber);
  // Grow the union, and reconnect ONLY if it actually grew. An existing
  // subscriber's topics are already covered, so the common case (a second
  // consumer of a topic already carried) joins a live socket untouched.
  let grew = false;
  for (const topic of subscriber.topics) {
    if (!shared.topics.has(topic)) {
      shared.topics.add(topic);
      grew = true;
    }
  }
  if (grew) shared.session.connect();
  // Replay the socket's current status, so a consumer joining an already-open
  // connection shows LIVE immediately rather than waiting for the next event.
  subscriber.setStatus(shared.status);
  return () => {
    const entry = SHARED_CHAIN_STREAMS.get(key);
    if (!entry) return;
    entry.subscribers.delete(subscriber);
    if (entry.subscribers.size > 0) return;
    entry.offNetwork();
    entry.offApiBase();
    entry.session.dispose();
    SHARED_CHAIN_STREAMS.delete(key);
  };
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
  /**
   * #8365. Called when the tab regains visibility after this hook paused its
   * connection while hidden -- never on first mount. The stream is fully
   * torn down while hidden (not merely throttled), so anything that would
   * have arrived in between was missed entirely; the caller's own refetch
   * (the same one already backstopping a downgrade to polling) is what
   * catches back up. Omit if the caller's existing poll/refetch cadence
   * already covers this on its own.
   */
  onVisible?: () => void;
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
  const {
    topics = ["chain_events"],
    enabled = true,
    onEvent,
    matches,
    debounceMs = 400,
    onVisible,
  } = options;
  const [status, setStatus] = useState<SseStatus>("idle");
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);

  const onEventRef = useRef(onEvent);
  const matchesRef = useRef(matches);
  const onVisibleRef = useRef(onVisible);
  onEventRef.current = onEvent;
  matchesRef.current = matches;
  onVisibleRef.current = onVisible;

  // #8365: pause the connection entirely while the tab is hidden (not merely
  // throttled) -- there's no reader to show live updates to, so the socket
  // is pure cost. `wasHiddenRef` records, at TEARDOWN time, whether that
  // teardown happened because the tab went hidden (checked via live
  // `document.hidden`, not the possibly-stale `visible` value this effect's
  // own closure captured) -- distinguishing "paused for hidden" from every
  // other reason this effect can tear down (unmount, `enabled` toggling
  // off, a topic/debounce change). Only the former should make the NEXT
  // connect fire `onVisible`.
  const visible = usePageVisible();
  const wasHiddenRef = useRef(false);

  // Serialize topics for a stable effect dep without requiring callers to
  // memoize the array literal.
  const topicsKey = topics.join(",");

  useEffect(() => {
    if (!enabled || typeof window === "undefined" || typeof EventSource === "undefined") {
      return;
    }
    if (!visible) {
      // The connection this effect's own PREVIOUS run may have held is
      // already torn down by that run's cleanup (React always runs the old
      // cleanup before this new run, even though this body then does
      // nothing) -- explicitly reflecting "idle" here is still necessary,
      // because without it `status` would otherwise freeze at whatever it
      // last was (possibly still "open"), which the LIVE chip would then
      // truthfully-but-wrongly keep showing for a connection that no longer
      // exists.
      setStatus("idle");
      return;
    }

    if (wasHiddenRef.current) {
      wasHiddenRef.current = false;
      onVisibleRef.current?.();
    }

    const topicList = topicsKey
      ? topicsKey.split(",").filter(Boolean)
      : (["chain_events"] as string[]);

    // This subscriber's OWN debounce, so pooling the socket does not pool the
    // coalescing: a consumer sees exactly the delivery it asked for.
    let pending: unknown = null;
    const flush = createDebouncedHandler(() => {
      if (pending === null) return;
      const payload = pending;
      pending = null;
      onEventRef.current?.(payload);
    }, debounceMs);

    const release = acquireSharedChainStream(
      // The socket's URL is the UNION of every consumer's topics, so it is
      // built from what the pool asks for rather than from this consumer's
      // own list.
      (unionTopics) => new EventSource(buildChainStreamUrl(unionTopics)),
      {
        topics: new Set(topicList),
        getMatches: () => matchesRef.current,
        setStatus,
        markActivity: () => setLastEventAt(new Date().toISOString()),
        deliver: (payload) => {
          pending = payload;
          flush();
        },
        cancel: flush.cancel,
      },
    );

    return () => {
      // Cancel BEFORE releasing: a frame already scheduled by this
      // subscriber's debounce would otherwise fire into an unmounted
      // consumer, which is the same stale-delivery hazard #8179 fixed for
      // the reconnect path.
      flush.cancel();
      release();
      if (typeof document !== "undefined" && document.hidden) {
        wasHiddenRef.current = true;
      }
    };
  }, [enabled, visible, topicsKey, debounceMs]);

  return { status, lastEventAt };
}
