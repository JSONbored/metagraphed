import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import {
  normalizeSubnetConviction,
  normalizeSubnetConvictionEntry,
  subnetConvictionQuery,
} from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/subnets/7/conviction",
  });
}

// Mirrors queries.subnet-ohlc.test.ts's own runQuery helper.
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
  hotkey: "5Hot1",
  is_owner: true,
  locked_mass: 12_801_009_134,
  conviction: 12_800_000_000,
};

describe("normalizeSubnetConvictionEntry", () => {
  it("passes a well-formed entry through", () => {
    expect(normalizeSubnetConvictionEntry(RAW_ENTRY)).toEqual(RAW_ENTRY);
  });

  it("returns null for a non-object row", () => {
    for (const raw of [null, undefined, 42, "x", []]) {
      expect(normalizeSubnetConvictionEntry(raw)).toBeNull();
    }
  });

  it("returns null when hotkey is missing", () => {
    expect(normalizeSubnetConvictionEntry({ ...RAW_ENTRY, hotkey: undefined })).toBeNull();
    expect(normalizeSubnetConvictionEntry({ ...RAW_ENTRY, hotkey: "" })).toBeNull();
  });

  it("coerces junk numeric fields to 0 and non-true is_owner to false", () => {
    const entry = normalizeSubnetConvictionEntry({
      hotkey: "5Hot1",
      is_owner: "yes",
      locked_mass: "not-a-number",
      conviction: undefined,
    });
    expect(entry).toEqual({ hotkey: "5Hot1", is_owner: false, locked_mass: 0, conviction: 0 });
  });
});

describe("normalizeSubnetConviction", () => {
  it("passes a well-formed response through", () => {
    const raw = {
      schema_version: 1,
      netuid: 7,
      queried_at_block: 8_647_000,
      unlock_rate: 934_866,
      maturity_rate: 311_622,
      king: "5Hot1",
      count: 1,
      leaderboard: [RAW_ENTRY],
    };
    expect(normalizeSubnetConviction(7, raw)).toEqual(raw);
  });

  it("degrades cold / junk input to a schema-stable empty leaderboard", () => {
    for (const raw of [{}, null, undefined, "not-an-object"]) {
      const data = normalizeSubnetConviction(7, raw);
      expect(data.netuid).toBe(7);
      expect(data.schema_version).toBe(1);
      expect(data.queried_at_block).toBeNull();
      expect(data.unlock_rate).toBeNull();
      expect(data.maturity_rate).toBeNull();
      expect(data.king).toBeNull();
      expect(data.count).toBe(0);
      expect(data.leaderboard).toEqual([]);
    }
  });

  it("drops a malformed leaderboard entry without dropping the rest of the batch", () => {
    const data = normalizeSubnetConviction(7, {
      leaderboard: [RAW_ENTRY, { hotkey: "" }, { ...RAW_ENTRY, hotkey: "5Hot2" }],
    });
    expect(data.leaderboard).toHaveLength(2);
  });

  it("falls back to the requested netuid when the server omits it", () => {
    const data = normalizeSubnetConviction(12, {});
    expect(data.netuid).toBe(12);
  });
});

describe("subnetConvictionQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("hits its route", async () => {
    resolveWith({ netuid: 7, leaderboard: [] });
    const res = await runQuery(subnetConvictionQuery(7));
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/subnets/7/conviction",
      expect.objectContaining({}),
    );
    expect(res.data.netuid).toBe(7);
  });

  it("normalizes the response through normalizeSubnetConviction", async () => {
    resolveWith({ leaderboard: [RAW_ENTRY], king: "5Hot1" });
    const res = await runQuery(subnetConvictionQuery(7));
    expect(res.data.leaderboard).toEqual([RAW_ENTRY]);
    expect(res.data.king).toBe("5Hot1");
  });
});
