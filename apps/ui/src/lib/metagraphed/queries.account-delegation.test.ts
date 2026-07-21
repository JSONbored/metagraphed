import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { accountChildrenQuery, accountParentsQuery } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

// Valid-format ss58 addresses (ss58PathSegment rejects malformed input).
const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const BOB = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

function resolveWith(data: unknown, url: string): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url,
  });
}

async function runChildren(ss58: string) {
  const opts = accountChildrenQuery(ss58);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

async function runParents(ss58: string) {
  const opts = accountParentsQuery(ss58);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("accountChildrenQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("hits the children route and reads the per-entry `child` counterpart field", async () => {
    resolveWith(
      {
        schema_version: 1,
        account: ALICE,
        subnets: [
          {
            netuid: 3,
            entries: [
              { child: BOB, proportion: "9223372036854775808", proportion_fraction: 0.5 },
            ],
          },
        ],
        queried_at: "2026-07-21T00:00:00.000Z",
      },
      `/api/v1/accounts/${ALICE}/children`,
    );
    const res = await runChildren(ALICE);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      `/api/v1/accounts/${ALICE}/children`,
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(res.data.account).toBe(ALICE);
    expect(res.data.queried_at).toBe("2026-07-21T00:00:00.000Z");
    expect(res.data.subnets).toEqual([
      {
        netuid: 3,
        entries: [
          { counterpart: BOB, proportion: "9223372036854775808", proportion_fraction: 0.5 },
        ],
      },
    ]);
  });

  it("preserves `subnets: null` (live RPC failed) as a distinct tri-state, not []", async () => {
    resolveWith(
      { schema_version: 1, account: ALICE, subnets: null, queried_at: null },
      `/api/v1/accounts/${ALICE}/children`,
    );
    const res = await runChildren(ALICE);
    expect(res.data.subnets).toBeNull();
  });

  it("drops subnets with no netuid, entries with no counterpart, and coerces junk fractions to null", async () => {
    resolveWith(
      {
        account: ALICE,
        subnets: [
          { netuid: "nope", entries: [{ child: BOB, proportion_fraction: 1 }] }, // no numeric netuid → dropped
          {
            netuid: 7,
            entries: [
              { proportion_fraction: 1 }, // no child → dropped
              { child: BOB, proportion: 123, proportion_fraction: "junk" },
            ],
          },
        ],
      },
      `/api/v1/accounts/${ALICE}/children`,
    );
    const res = await runChildren(ALICE);
    expect(res.data.subnets).toEqual([
      {
        netuid: 7,
        entries: [{ counterpart: BOB, proportion: null, proportion_fraction: null }],
      },
    ]);
  });

  it("degrades a cold / unknown account to an empty subnet list (never throws)", async () => {
    for (const raw of [{}, null, { subnets: "not-an-array" }]) {
      resolveWith(raw, `/api/v1/accounts/${ALICE}/children`);
      const res = await runChildren(ALICE);
      expect(res.data.account).toBe(ALICE);
      expect(res.data.subnets).toEqual([]);
    }
  });
});

describe("accountParentsQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("hits the parents route and reads the per-entry `parent` counterpart field", async () => {
    resolveWith(
      {
        account: ALICE,
        subnets: [{ netuid: 1, entries: [{ parent: BOB, proportion_fraction: 0.25 }] }],
      },
      `/api/v1/accounts/${ALICE}/parents`,
    );
    const res = await runParents(ALICE);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      `/api/v1/accounts/${ALICE}/parents`,
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(res.data.subnets).toEqual([
      { netuid: 1, entries: [{ counterpart: BOB, proportion: null, proportion_fraction: 0.25 }] },
    ]);
  });
});
