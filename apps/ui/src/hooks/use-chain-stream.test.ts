import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChainStreamSource, ChainStreamSessionDeps, SseStatus } from "./use-chain-stream";
import {
  accountEventHotkeyIn,
  accountEventMatchesNetuid,
  accountEventNetuidIn,
  buildChainStreamUrl,
  chainStreamEventMatchesFilters,
  CHAIN_STREAM_DOWNGRADE_AFTER_FAILURES,
  CHAIN_STREAM_DOWNGRADE_RETRY_MS,
  createChainStreamSession,
  acquireSharedChainStream,
  activeSharedChainStreamCount,
  sharedChainStreamTopics,
  createDebouncedHandler,
  parseChainStreamPayload,
} from "./use-chain-stream";

describe("buildChainStreamUrl", () => {
  it("targets /api/v1/chain/stream on the current API base", () => {
    const url = buildChainStreamUrl();
    expect(url).toContain("/api/v1/chain/stream");
    expect(url).not.toContain("topics=");
  });

  it("appends a comma-separated topics filter and drops unknowns", () => {
    const url = buildChainStreamUrl(["chain_events", "nope", "blocks"]);
    const parsed = new URL(url);
    expect(parsed.searchParams.get("topics")).toBe("chain_events,blocks");
  });
});

describe("chainStreamEventMatchesFilters", () => {
  const row = { table: "chain_events", pallet: "Balances", method: "Deposit", block_number: 1 };

  it("accepts any chain_events row when filters are empty", () => {
    expect(chainStreamEventMatchesFilters(row, "", "")).toBe(true);
  });

  it("requires pallet (and method when set) to match", () => {
    expect(chainStreamEventMatchesFilters(row, "Balances", "")).toBe(true);
    expect(chainStreamEventMatchesFilters(row, "Balances", "Deposit")).toBe(true);
    expect(chainStreamEventMatchesFilters(row, "Balances", "Transfer")).toBe(false);
    expect(chainStreamEventMatchesFilters(row, "SubtensorModule", "")).toBe(false);
  });

  it("rejects non-chain_events tables and junk payloads", () => {
    expect(chainStreamEventMatchesFilters({ table: "blocks", block_number: 1 }, "", "")).toBe(
      false,
    );
    expect(chainStreamEventMatchesFilters(null, "", "")).toBe(false);
    expect(chainStreamEventMatchesFilters("x", "", "")).toBe(false);
  });
});

describe("accountEventMatchesNetuid", () => {
  it("matches an account_events row for the given netuid", () => {
    const row = { table: "account_events", netuid: 19, hotkey: "5abc", amount_tao: 1.5 };
    expect(accountEventMatchesNetuid(row, 19)).toBe(true);
    expect(accountEventMatchesNetuid(row, 4)).toBe(false);
  });

  it("rejects non-account_events tables and junk payloads", () => {
    expect(accountEventMatchesNetuid({ table: "chain_events", netuid: 19 }, 19)).toBe(false);
    expect(accountEventMatchesNetuid(null, 19)).toBe(false);
    expect(accountEventMatchesNetuid("x", 19)).toBe(false);
  });
});

describe("accountEventNetuidIn", () => {
  const watched = new Set(["19", "4"]);

  it("matches when the payload's netuid is in the watched set", () => {
    expect(accountEventNetuidIn({ table: "account_events", netuid: 19 }, watched)).toBe(true);
    expect(accountEventNetuidIn({ table: "account_events", netuid: 4 }, watched)).toBe(true);
  });

  it("rejects a netuid outside the set, non-account_events tables, and junk", () => {
    expect(accountEventNetuidIn({ table: "account_events", netuid: 8 }, watched)).toBe(false);
    expect(accountEventNetuidIn({ table: "chain_events", netuid: 19 }, watched)).toBe(false);
    expect(accountEventNetuidIn(null, watched)).toBe(false);
    expect(accountEventNetuidIn("x", watched)).toBe(false);
  });
});

describe("accountEventHotkeyIn", () => {
  const watched = new Set(["5abc", "5def"]);

  it("matches when the payload's hotkey is in the watched set", () => {
    expect(accountEventHotkeyIn({ table: "account_events", hotkey: "5abc" }, watched)).toBe(true);
  });

  it("rejects a hotkey outside the set, non-account_events tables, and junk", () => {
    expect(accountEventHotkeyIn({ table: "account_events", hotkey: "5zzz" }, watched)).toBe(false);
    expect(accountEventHotkeyIn({ table: "chain_events", hotkey: "5abc" }, watched)).toBe(false);
    expect(accountEventHotkeyIn({ table: "account_events" }, watched)).toBe(false);
    expect(accountEventHotkeyIn(null, watched)).toBe(false);
    expect(accountEventHotkeyIn("x", watched)).toBe(false);
  });
});

describe("parseChainStreamPayload", () => {
  it("parses JSON and returns null for empty/malformed", () => {
    expect(parseChainStreamPayload('{"table":"chain_events"}')).toEqual({
      table: "chain_events",
    });
    expect(parseChainStreamPayload("")).toBeNull();
    expect(parseChainStreamPayload("{")).toBeNull();
    expect(parseChainStreamPayload(null)).toBeNull();
  });
});

describe("createDebouncedHandler", () => {
  it("coalesces rapid calls into one invocation", () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const debounced = createDebouncedHandler(run, 400);

    debounced();
    debounced();
    debounced();
    expect(run).not.toHaveBeenCalled();

    vi.advanceTimersByTime(400);
    expect(run).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it("cancel() drops a scheduled, not-yet-fired invocation (#8179)", () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const debounced = createDebouncedHandler(run, 400);

    debounced();
    debounced.cancel();

    vi.advanceTimersByTime(1000);
    expect(run).not.toHaveBeenCalled();

    // The handler stays usable after a cancel.
    debounced();
    vi.advanceTimersByTime(400);
    expect(run).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });
});

/**
 * Minimal stand-in for the `EventSource` slice `createChainStreamSession`
 * consumes (same plain-node approach as `use-in-view.test.ts`'s
 * IntersectionObserver mock -- no jsdom/renderHook in this suite).
 */
class MockChainSource implements ChainStreamSource {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  closed = false;
  private listeners = new Map<string, Array<(ev: Event) => void>>();

  addEventListener(type: string, listener: (ev: Event) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(listener);
    this.listeners.set(type, arr);
  }

  close(): void {
    this.closed = true;
  }

  emitChain(payload: unknown): void {
    const ev = { data: JSON.stringify(payload) } as MessageEvent;
    for (const listener of this.listeners.get("chain") ?? []) listener(ev);
  }

  /** Simulates a successful connection -- fires every registered "open" listener. */
  emitOpen(): void {
    for (const listener of this.listeners.get("open") ?? []) listener({} as Event);
  }

  /**
   * Simulates one failed connection attempt on this SAME source object --
   * matching real `EventSource` semantics, where a native auto-reconnect
   * retry that fails fires ANOTHER "error" on the same instance rather than
   * creating a new one. Callable repeatedly to build up
   * `consecutiveFailures` (#8365).
   */
  emitError(): void {
    for (const listener of this.listeners.get("error") ?? []) listener({} as Event);
  }
}

describe("createChainStreamSession", () => {
  function makeSession(overrides: Partial<ChainStreamSessionDeps> = {}) {
    const sources: MockChainSource[] = [];
    const onEvent = vi.fn();
    const statuses: SseStatus[] = [];
    const session = createChainStreamSession({
      openSource: () => {
        const source = new MockChainSource();
        sources.push(source);
        return source;
      },
      getOnEvent: () => onEvent,
      getMatches: () => undefined,
      debounceMs: 400,
      setStatus: (s) => statuses.push(s),
      markActivity: () => {},
      ...overrides,
    });
    return { session, sources, onEvent, statuses };
  }

  it("delivers a debounced frame that is not superseded by a reconnect", () => {
    vi.useFakeTimers();
    const { session, sources, onEvent } = makeSession();

    session.connect();
    sources[0].emitChain({ table: "chain_events", pallet: "Balances" });
    expect(onEvent).not.toHaveBeenCalled();

    vi.advanceTimersByTime(400);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({ table: "chain_events", pallet: "Balances" });

    vi.useRealTimers();
  });

  it("reconnect before the debounce fires drops the stale connection's frame (#8179)", () => {
    vi.useFakeTimers();
    const { session, sources, onEvent } = makeSession();

    session.connect();
    sources[0].emitChain({ table: "chain_events", network: "old-network" });

    // Network/API-base switch mid-debounce: the old source is closed and the
    // old pending flush must never reach onEvent.
    vi.advanceTimersByTime(200);
    session.connect();
    expect(sources[0].closed).toBe(true);

    vi.advanceTimersByTime(1000);
    expect(onEvent).not.toHaveBeenCalled();

    // The new connection's frames still flow.
    sources[1].emitChain({ table: "chain_events", network: "new-network" });
    vi.advanceTimersByTime(400);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({ table: "chain_events", network: "new-network" });

    vi.useRealTimers();
  });

  it("dispose (unmount) before the debounce fires drops the pending frame (#8179)", () => {
    vi.useFakeTimers();
    const { session, sources, onEvent } = makeSession();

    session.connect();
    sources[0].emitChain({ table: "chain_events", network: "old-network" });

    vi.advanceTimersByTime(200);
    session.dispose();
    expect(sources[0].closed).toBe(true);

    vi.advanceTimersByTime(1000);
    expect(onEvent).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  // --- auto-downgrade after repeated connect failures (#8365) -------------
  //
  // Every consumer already has its own polling fallback (the documented
  // gap-cover); these tests are about the STREAM itself no longer hammering
  // a down endpoint in a tight loop once it's clearly not coming back soon.

  it("under the failure threshold, lets EventSource's own auto-reconnect keep retrying on the same source", () => {
    const { session, sources } = makeSession();
    session.connect();

    for (let i = 0; i < CHAIN_STREAM_DOWNGRADE_AFTER_FAILURES - 1; i += 1) {
      sources[0]!.emitError();
    }

    // Not closed, and no second `openSource()` call -- we haven't taken
    // over yet, so the native EventSource is left to keep retrying itself.
    expect(sources[0]!.closed).toBe(false);
    expect(sources).toHaveLength(1);
  });

  it("at the failure threshold, closes the connection and takes over reconnect scheduling", () => {
    vi.useFakeTimers();
    const { session, sources } = makeSession();
    session.connect();

    for (let i = 0; i < CHAIN_STREAM_DOWNGRADE_AFTER_FAILURES; i += 1) {
      sources[0]!.emitError();
    }
    expect(sources[0]!.closed).toBe(true);

    // No reconnect yet -- it's scheduled, not immediate.
    vi.advanceTimersByTime(CHAIN_STREAM_DOWNGRADE_RETRY_MS - 1);
    expect(sources).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(sources).toHaveLength(2);

    vi.useRealTimers();
  });

  it("a successful open resets the failure counter, so the threshold needs a full fresh run", () => {
    const { session, sources } = makeSession();
    session.connect();

    // One short of the threshold, then a successful connect.
    for (let i = 0; i < CHAIN_STREAM_DOWNGRADE_AFTER_FAILURES - 1; i += 1) {
      sources[0]!.emitError();
    }
    sources[0]!.emitOpen();

    // Two more errors -- still under a FRESH threshold count (2 < 3) --
    // must not have closed the connection.
    sources[0]!.emitError();
    sources[0]!.emitError();
    expect(sources[0]!.closed).toBe(false);
  });

  it("the downgrade retry does not fire after dispose()", () => {
    vi.useFakeTimers();
    const { session, sources } = makeSession();
    session.connect();

    for (let i = 0; i < CHAIN_STREAM_DOWNGRADE_AFTER_FAILURES; i += 1) {
      sources[0]!.emitError();
    }
    session.dispose();

    vi.advanceTimersByTime(CHAIN_STREAM_DOWNGRADE_RETRY_MS + 1000);
    // Only the original source -- the disposed session never reconnects.
    expect(sources).toHaveLength(1);

    vi.useRealTimers();
  });

  it("an explicit reconnect (e.g. a network change) resets the failure counter for the new attempt", () => {
    const { session, sources } = makeSession();
    session.connect();

    for (let i = 0; i < CHAIN_STREAM_DOWNGRADE_AFTER_FAILURES - 1; i += 1) {
      sources[0]!.emitError();
    }

    // A fresh, unrelated connect() -- the new source starts its own count
    // at 0, not inheriting the old source's near-threshold tally.
    session.connect();
    expect(sources).toHaveLength(2);
    sources[1]!.emitError();
    sources[1]!.emitError();
    expect(sources[1]!.closed).toBe(false);
  });

  it("status transitions: connecting -> open -> error, and error again on each retry", () => {
    const { session, sources, statuses } = makeSession();
    session.connect();
    expect(statuses).toEqual(["connecting"]);

    sources[0]!.emitOpen();
    expect(statuses).toEqual(["connecting", "open"]);

    sources[0]!.emitError();
    expect(statuses).toEqual(["connecting", "open", "error"]);
  });
});

/**
 * `expect(a).toEqual(b)` with a message, so a pooling failure says WHICH
 * invariant broke rather than printing two object dumps.
 */
function expectEq(actual: unknown, expected: unknown, message?: string): void {
  expect(actual, message).toEqual(expected);
}

// ── One socket per topic set, not one per call site (#10606) ───────────────
//
// THE BUG. `useChainStream` opened its own EventSource per CALL SITE, and
// there are six: two in home-watched-module, plus registry-ticker (in the
// header, so on every page), chain-events-feed, live-block-rail and the subnet
// detail route. Three ask for `account_events` and two for `blocks` --
// identical URLs, separate sockets.
//
// The server caps ONE IP at 20 concurrent SSE connections, so a handful of
// tabs reaches it unaided. /api/v1/chain/stream ran at ~95% 5xx for days, and
// once cap attribution shipped every refusal came back
// `chain_firehose_cap_sse_per_ip` -- not the global cap, and not
// `:unattributed`. The app was refusing itself.
describe("acquireSharedChainStream", () => {
  function fakeSource() {
    const listeners = new Map<string, (ev: Event) => void>();
    return {
      closed: 0,
      listeners,
      addEventListener(type: string, listener: (ev: Event) => void) {
        listeners.set(type, listener);
      },
      close() {
        this.closed += 1;
      },
      onmessage: null as ((ev: MessageEvent) => void) | null,
      emit(payload: unknown) {
        listeners.get("chain")?.({
          data: JSON.stringify(payload),
        } as unknown as Event);
      },
      open() {
        listeners.get("open")?.(new Event("open"));
      },
    };
  }

  function subscriber(topics: string[], overrides: Partial<Record<string, unknown>> = {}) {
    const seen: unknown[] = [];
    const statuses: string[] = [];
    let activity = 0;
    return {
      seen,
      statuses,
      get activity() {
        return activity;
      },
      sub: {
        topics: new Set(topics),
        getMatches: () => undefined,
        setStatus: (s: string) => statuses.push(s),
        markActivity: () => {
          activity += 1;
        },
        deliver: (p: unknown) => seen.push(p),
        cancel: () => {},
        ...overrides,
      },
    };
  }

  afterEach(() => {
    expectEq(activeSharedChainStreamCount(), 0, "a shared connection outlived its last subscriber");
  });

  it("consumers of DIFFERENT topics share one socket", () => {
    // The #10952 pool keyed by topic set, so a tab holding `blocks`,
    // `account_events` and `chain_events` held three sockets. Against a 20
    // per-IP cap that still breaks at seven tabs, and it did: refusals fell
    // ~75% and did not stop.
    let opened = 0;
    const src = fakeSource();
    const open = () => {
      opened += 1;
      return src;
    };
    const a = subscriber(["blocks"]);
    const b = subscriber(["account_events"]);
    const releaseA = acquireSharedChainStream(open, a.sub);
    const releaseB = acquireSharedChainStream(open, b.sub);
    expectEq(activeSharedChainStreamCount(), 1, "a tab must hold ONE socket");
    expectEq(sharedChainStreamTopics(), ["account_events", "blocks"]);
    // Two opens, because the union GREW: the second consumer needed a topic
    // the live URL did not carry.
    expectEq(opened, 2);
    releaseA();
    releaseB();
  });

  it("a topic already carried joins the live socket without reopening", () => {
    // The common case, and the one that must not churn: two consumers of the
    // same topic (registry-ticker and live-block-rail both want `blocks`).
    let opened = 0;
    const src = fakeSource();
    const open = () => {
      opened += 1;
      return src;
    };
    const a = subscriber(["blocks"]);
    const b = subscriber(["blocks"]);
    const releaseA = acquireSharedChainStream(open, a.sub);
    const releaseB = acquireSharedChainStream(open, b.sub);
    expectEq(opened, 1, "an already-covered topic must not reopen the socket");
    releaseA();
    releaseB();
  });

  it("the union never shrinks when a consumer leaves", () => {
    // Shrinking would reopen on every navigation — a reconnect storm against
    // a cap on CONCURRENT connections, which is the failure being fixed.
    let opened = 0;
    const src = fakeSource();
    const open = () => {
      opened += 1;
      return src;
    };
    const a = subscriber(["blocks"]);
    const b = subscriber(["account_events"]);
    const releaseA = acquireSharedChainStream(open, a.sub);
    const releaseB = acquireSharedChainStream(open, b.sub);
    const openedAfterBoth = opened;
    releaseA();
    expectEq(sharedChainStreamTopics(), ["account_events", "blocks"]);
    expectEq(opened, openedAfterBoth, "unmounting a consumer reopened the socket");
    releaseB();
  });

  it("the socket survives one consumer leaving and closes with the last", () => {
    const src = fakeSource();
    const a = subscriber(["blocks"]);
    const b = subscriber(["blocks"]);
    const releaseA = acquireSharedChainStream(() => src, a.sub);
    const releaseB = acquireSharedChainStream(() => src, b.sub);
    releaseA();
    expectEq(src.closed, 0, "unmounting one consumer closed the shared socket");
    releaseB();
    expectEq(src.closed, 1, "the last consumer left and the socket stayed open");
  });

  it("each subscriber receives only ITS OWN topics", () => {
    // THE NEW OBLIGATION. The URL carries the union, so the topic filter the
    // server used to apply now has to happen here — same rule as
    // chainFirehoseMatchesTopics: `topics.has(payload.table)`.
    const src = fakeSource();
    const a = subscriber(["blocks"]);
    const b = subscriber(["account_events"]);
    const releaseA = acquireSharedChainStream(() => src, a.sub);
    const releaseB = acquireSharedChainStream(() => src, b.sub);
    src.emit({ table: "blocks", block_number: 1 });
    src.emit({ table: "account_events", id: 7 });
    expectEq(a.seen, [{ table: "blocks", block_number: 1 }]);
    expectEq(b.seen, [{ table: "account_events", id: 7 }]);
    // markActivity follows the same filter, so a consumer's LIVE chip is not
    // refreshed by another consumer's traffic.
    expectEq(a.activity, 1);
    expectEq(b.activity, 1);
    releaseA();
    releaseB();
  });

  it("a frame for no subscribed topic is dropped by everyone", () => {
    const src = fakeSource();
    const a = subscriber(["blocks"]);
    const releaseA = acquireSharedChainStream(() => src, a.sub);
    src.emit({ table: "something_else", id: 1 });
    expectEq(a.seen, []);
    releaseA();
  });

  it("each subscriber still applies its OWN matches", () => {
    const src = fakeSource();
    const a = subscriber(["blocks"], {
      getMatches: () => (p: unknown) => (p as { block_number: number }).block_number > 5,
    });
    const b = subscriber(["blocks"]);
    const releaseA = acquireSharedChainStream(() => src, a.sub);
    const releaseB = acquireSharedChainStream(() => src, b.sub);
    src.emit({ table: "blocks", block_number: 1 });
    src.emit({ table: "blocks", block_number: 9 });
    expectEq(a.seen, [{ table: "blocks", block_number: 9 }]);
    expectEq(b.seen, [
      { table: "blocks", block_number: 1 },
      { table: "blocks", block_number: 9 },
    ]);
    releaseA();
    releaseB();
  });

  it("a late subscriber is told the connection is already open", () => {
    const src = fakeSource();
    const a = subscriber(["blocks"]);
    const releaseA = acquireSharedChainStream(() => src, a.sub);
    src.open();
    const b = subscriber(["blocks"]);
    const releaseB = acquireSharedChainStream(() => src, b.sub);
    expectEq(b.statuses.at(-1), "open");
    releaseA();
    releaseB();
  });

  it("a released subscriber stops receiving frames", () => {
    const src = fakeSource();
    const a = subscriber(["blocks"]);
    const b = subscriber(["blocks"]);
    const releaseA = acquireSharedChainStream(() => src, a.sub);
    const releaseB = acquireSharedChainStream(() => src, b.sub);
    releaseA();
    src.emit({ table: "blocks", block_number: 2 });
    expectEq(a.seen, [], "an unmounted consumer still received a frame");
    expectEq(b.seen, [{ table: "blocks", block_number: 2 }]);
    releaseB();
  });
});
