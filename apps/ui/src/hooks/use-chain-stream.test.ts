import { describe, expect, it, vi } from "vitest";

import {
  buildChainStreamUrl,
  chainStreamEventMatchesFilters,
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
});
