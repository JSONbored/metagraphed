import { describe, expect, it } from "vitest";

import { CHAIN_EVENTS_PAGE_SIZE, chainEventsBaseParams } from "./chain-events-feed";

describe("chainEventsBaseParams", () => {
  it("sends only the page size when no filters are set", () => {
    expect(chainEventsBaseParams("", "")).toEqual({ limit: CHAIN_EVENTS_PAGE_SIZE });
  });

  it("includes the pallet when set", () => {
    expect(chainEventsBaseParams("System", "")).toEqual({
      limit: CHAIN_EVENTS_PAGE_SIZE,
      pallet: "System",
    });
  });

  it("includes method only alongside a pallet (API conjunctive contract)", () => {
    // method without a pallet is meaningless to the API, so it's dropped.
    expect(chainEventsBaseParams("", "ExtrinsicSuccess")).toEqual({
      limit: CHAIN_EVENTS_PAGE_SIZE,
    });
    expect(chainEventsBaseParams("System", "ExtrinsicSuccess")).toEqual({
      limit: CHAIN_EVENTS_PAGE_SIZE,
      pallet: "System",
      method: "ExtrinsicSuccess",
    });
  });

  it("trims surrounding whitespace before deciding what to send", () => {
    expect(chainEventsBaseParams("  System  ", "  ExtrinsicSuccess  ")).toEqual({
      limit: CHAIN_EVENTS_PAGE_SIZE,
      pallet: "System",
      method: "ExtrinsicSuccess",
    });
    // whitespace-only pallet collapses to "no filters" and drops the method too.
    expect(chainEventsBaseParams("   ", "ExtrinsicSuccess")).toEqual({
      limit: CHAIN_EVENTS_PAGE_SIZE,
    });
  });
});
