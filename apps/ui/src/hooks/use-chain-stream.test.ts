import { describe, expect, it, vi } from "vitest";

import type { ChainStreamSource, ChainStreamSessionDeps } from "./use-chain-stream";
import {
  accountEventMatchesNetuid,
  buildChainStreamUrl,
  chainStreamEventMatchesFilters,
  createChainStreamSession,
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
}

describe("createChainStreamSession", () => {
  function makeSession(overrides: Partial<ChainStreamSessionDeps> = {}) {
    const sources: MockChainSource[] = [];
    const onEvent = vi.fn();
    const session = createChainStreamSession({
      openSource: () => {
        const source = new MockChainSource();
        sources.push(source);
        return source;
      },
      getOnEvent: () => onEvent,
      getMatches: () => undefined,
      debounceMs: 400,
      setStatus: () => {},
      markActivity: () => {},
      ...overrides,
    });
    return { session, sources, onEvent };
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
});
