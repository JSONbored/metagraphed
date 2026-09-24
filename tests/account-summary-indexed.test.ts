import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadAccountSummaryColdTier } from "../src/account-feeds-cold-tier.ts";
import { loadAccountSummaryProjection } from "../src/account-summary-projection.ts";
import {
  loadIndexedAccountFeedGroups,
  loadIndexedAccountFeedPage,
} from "../src/indexed-account-feeds.ts";
import type { AccountFeedGroup } from "../src/history-account-feed-groups.ts";

vi.mock("../src/account-summary-projection.ts", () => ({
  loadAccountSummaryProjection: vi.fn(),
}));
vi.mock("../src/indexed-account-feeds.ts", () => ({
  loadIndexedAccountFeedGroups: vi.fn(),
  loadIndexedAccountFeedPage: vi.fn(),
}));
const projection = vi.mocked(loadAccountSummaryProjection);
const groups = vi.mocked(loadIndexedAccountFeedGroups);
const page = vi.mocked(loadIndexedAccountFeedPage);
const address = "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F";
const tail: AccountFeedGroup = {
  event_kind: "StakeAdded",
  netuid: 7,
  event_count: 6001,
  total_tao: null,
  total_alpha: null,
  first_block: 20,
  last_block: 30,
  first_observed: 2000,
  last_observed: 3000,
};
const published = {
  kind: "StakeAdded",
  netuid: 7,
  count: 20000,
  fb: 1,
  lb: 10,
  fo: 100,
  lo: 1000,
};
const selectors = [
  { side: "hotkey", account: address },
  { side: "coldkey", account: address },
];
beforeEach(() => {
  projection.mockReset().mockResolvedValue(null);
  groups.mockReset().mockResolvedValue([tail]);
  page.mockReset().mockResolvedValue([]);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("SQL must not run");
    }),
  );
});

describe("indexed account summary", () => {
  it("keeps lifetime counts above the old cap while querying only the unpublished tail", async () => {
    projection.mockResolvedValue({
      groups: [published],
      span: { firstMs: 100, lastMs: 1000, foldFloorMs: 2000 },
      recent: null,
    });
    const result = await loadAccountSummaryColdTier({}, address, {
      recentLimit: 3,
    });
    expect(result).toEqual({
      agg: { c: 26001, fb: 1, lb: 30, fo: 100, lo: 3000, sc: 1 },
      kinds: [{ kind: "StakeAdded", count: 26001 }],
      scanned: 26001,
      complete: true,
      recent: [],
    });
    expect(groups).toHaveBeenCalledWith(
      {},
      selectors.map((s) => ({ ...s, observedStart: 2000 })),
    );
    expect(page).toHaveBeenCalledWith({}, selectors, 3);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("reads the full qualified history when the projection has no trustworthy fold edge", async () => {
    for (const projected of [
      null,
      { groups: [published], span: null, recent: null },
    ]) {
      projection.mockResolvedValue(projected);
      expect(await loadAccountSummaryColdTier({}, address)).toEqual({
        agg: { c: 6001, fb: 20, lb: 30, fo: 2000, lo: 3000, sc: 1 },
        kinds: [{ kind: "StakeAdded", count: 6001 }],
        scanned: 6001,
        complete: true,
        recent: [],
      });
      expect(groups).toHaveBeenLastCalledWith(
        {},
        selectors.map((s) => ({ ...s, observedStart: undefined })),
      );
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses proven absence as a floor and preserves an empty result as complete", async () => {
    projection.mockResolvedValue({ absent: true, floorMs: 2000 });
    groups.mockResolvedValue([]);
    expect(await loadAccountSummaryColdTier({}, address)).toEqual({
      agg: { c: 0, fb: null, lb: null, fo: null, lo: null, sc: 0 },
      kinds: [],
      scanned: 0,
      complete: true,
      recent: [],
    });
    expect(groups).toHaveBeenCalledWith(
      {},
      selectors.map((s) => ({ ...s, observedStart: 2000 })),
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("fails closed on either corrupt selected leg and waits for both to be qualified", async () => {
    for (const [aggregate, recent] of [
      [null, []],
      [[], null],
      [null, undefined],
      [undefined, null],
    ] as const) {
      groups.mockResolvedValue(
        aggregate === null ? null : aggregate === undefined ? undefined : [],
      );
      page.mockResolvedValue(
        recent === null ? null : recent === undefined ? undefined : [],
      );
      expect(await loadAccountSummaryColdTier({}, address)).toEqual({
        declined: ["indexed history: account summary read failed"],
      });
    }
    for (const [aggregate, recent] of [
      [undefined, []],
      [[], undefined],
      [undefined, undefined],
    ] as const) {
      groups.mockResolvedValue(aggregate === undefined ? undefined : []);
      page.mockResolvedValue(recent === undefined ? undefined : []);
      expect(
        await loadAccountSummaryColdTier({}, address, {
          query: async () => null,
        }),
      ).toEqual({ declined: [] });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
