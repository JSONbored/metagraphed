// The subnet alpha-holder leaderboard query (#9557 backend, #9597 frontend).
//
// The assertions that matter here are all about NOT COERCING NULLS. The route
// declines rather than answering in two states -- the pool ledger has no
// complete pass, or netuid 0, which the chain's Alpha map does not cover -- and
// a decline arrives as `holders: []` with every aggregate null plus a
// `degraded` block. A `?? 0` anywhere in this normalizer would turn "we could
// not rank this subnet" into "this subnet has 0 holders holding 0 alpha", which
// is exactly the confusion the backend's degraded block exists to prevent,
// recreated one layer up and invisible in the UI.
//
// So: `degraded` must survive verbatim, and the aggregates must stay null.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { normalizeSubnetHolderEntry, normalizeSubnetHolders, subnetHoldersQuery } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/subnets/74/holders",
  });
}

function runQuery<
  O extends {
    queryKey: readonly unknown[];
    queryFn?: (context: never) => unknown;
  },
>(opts: O): ReturnType<NonNullable<O["queryFn"]>> {
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as never) as ReturnType<NonNullable<O["queryFn"]>>;
}

const RAW_ENTRY = {
  coldkey: "5Cold1",
  alpha: 250.5,
  share_of_total: 0.25,
  hotkey_count: 3,
};

const RAW_CARD = {
  schema_version: 1,
  netuid: 74,
  limit: 20,
  holder_count: 520,
  total_alpha: 1002,
  concentration: { top5_share: 0.31, top10_share: 0.44, top20_share: 0.58 },
  captured_at: "2026-08-05T18:00:00.000Z",
  positions_captured_at: "2026-08-05T18:14:34.407Z",
  holders: [RAW_ENTRY],
};

beforeEach(() => {
  mockedApiFetch.mockReset();
});

describe("normalizeSubnetHolderEntry", () => {
  it("passes a well-formed entry through", () => {
    expect(normalizeSubnetHolderEntry(RAW_ENTRY)).toEqual(RAW_ENTRY);
  });

  it("drops a non-object and a row with no coldkey", () => {
    expect(normalizeSubnetHolderEntry(null)).toBeNull();
    expect(normalizeSubnetHolderEntry("5Cold1")).toBeNull();
    expect(normalizeSubnetHolderEntry({ alpha: 1 })).toBeNull();
  });

  it("keeps a null share null rather than calling it zero", () => {
    // share_of_total is null when the subnet's measured total is zero. A 0%
    // share asserts the holder owns none of something; null says the question
    // has no answer. Same for hotkey_count.
    const entry = normalizeSubnetHolderEntry({
      coldkey: "5Cold1",
      alpha: 0,
      share_of_total: null,
      hotkey_count: null,
    });
    expect(entry).toEqual({
      coldkey: "5Cold1",
      alpha: 0,
      share_of_total: null,
      hotkey_count: null,
    });
  });

  it("defaults only the amount, because a named holder is still a holder", () => {
    const entry = normalizeSubnetHolderEntry({ coldkey: "5Cold1", alpha: "junk" });
    expect(entry?.alpha).toBe(0);
    expect(entry?.share_of_total).toBeNull();
  });
});

describe("normalizeSubnetHolders", () => {
  it("passes a well-formed card through", () => {
    expect(normalizeSubnetHolders(74, RAW_CARD)).toEqual({ ...RAW_CARD, degraded: null });
  });

  it("degrades a cold or junk payload to a schema-stable card", () => {
    for (const raw of [undefined, null, "nope", 42, []]) {
      const card = normalizeSubnetHolders(74, raw);
      expect(card.netuid).toBe(74);
      expect(card.holders).toEqual([]);
      expect(card.degraded).toBeNull();
      expect(card.holder_count).toBeNull();
      expect(card.concentration).toEqual({
        top5_share: null,
        top10_share: null,
        top20_share: null,
      });
    }
  });

  it("preserves a decline verbatim, with every aggregate still null", () => {
    // The shape the live route returns today: rows exist in the ledger and are
    // deliberately not ranked.
    const card = normalizeSubnetHolders(74, {
      schema_version: 1,
      netuid: 74,
      limit: 20,
      holder_count: null,
      total_alpha: null,
      concentration: { top5_share: null, top10_share: null, top20_share: null },
      captured_at: null,
      positions_captured_at: null,
      holders: [],
      degraded: { reason: "pool_totals_unproven" },
    });
    expect(card.degraded).toEqual({ reason: "pool_totals_unproven" });
    expect(card.holder_count).toBeNull();
    expect(card.total_alpha).toBeNull();
    expect(card.concentration.top5_share).toBeNull();
    expect(card.captured_at).toBeNull();
  });

  it("distinguishes a decline from a measured empty subnet", () => {
    // Both carry `holders: []`. Only the presence of `degraded` separates
    // "could not rank" from "nobody holds any", and the component branches on
    // exactly this.
    const declined = normalizeSubnetHolders(74, {
      holders: [],
      degraded: { reason: "root_not_in_alpha_map" },
    });
    const measured = normalizeSubnetHolders(74, {
      holders: [],
      holder_count: 0,
      total_alpha: 0,
    });
    expect(declined.degraded?.reason).toBe("root_not_in_alpha_map");
    expect(measured.degraded).toBeNull();
    // A MEASURED zero survives as a zero -- it is a real count, not an absence.
    expect(measured.holder_count).toBe(0);
    expect(measured.total_alpha).toBe(0);
  });

  it("ignores a malformed degraded block rather than inventing a reason", () => {
    expect(normalizeSubnetHolders(74, { degraded: {} }).degraded).toBeNull();
    expect(normalizeSubnetHolders(74, { degraded: "broken" }).degraded).toBeNull();
  });

  it("drops a malformed row without poisoning the batch", () => {
    const card = normalizeSubnetHolders(74, {
      ...RAW_CARD,
      holders: [RAW_ENTRY, null, { alpha: 5 }, { coldkey: "5Cold2", alpha: 10 }],
    });
    expect(card.holders.map((h) => h.coldkey)).toEqual(["5Cold1", "5Cold2"]);
  });

  it("falls back to the requested netuid when the payload omits it", () => {
    expect(normalizeSubnetHolders(74, { holders: [] }).netuid).toBe(74);
  });
});

describe("subnetHoldersQuery", () => {
  it("hits the holders route and normalizes the payload", async () => {
    resolveWith(RAW_CARD);
    const res = await runQuery(subnetHoldersQuery(74));
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/subnets/74/holders",
      expect.objectContaining({ params: undefined }),
    );
    expect(res.data.holders).toHaveLength(1);
    expect(res.data.holder_count).toBe(520);
  });

  it("passes an explicit limit through as a query param", async () => {
    resolveWith(RAW_CARD);
    await runQuery(subnetHoldersQuery(74, 50));
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/subnets/74/holders",
      expect.objectContaining({ params: { limit: "50" } }),
    );
  });

  it("keys the cache on the limit, so two page sizes do not share a slot", () => {
    expect(subnetHoldersQuery(74).queryKey).not.toEqual(subnetHoldersQuery(74, 50).queryKey);
  });
});
