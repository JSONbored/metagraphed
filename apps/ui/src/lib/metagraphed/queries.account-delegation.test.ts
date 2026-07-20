import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { accountChildrenQuery, accountParentsQuery } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const BOB = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

function resolveWith(path: string, data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: path,
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

  it("hits the children route and preserves a well-formed subnet row", async () => {
    resolveWith(`/api/v1/accounts/${ALICE}/children`, {
      schema_version: 1,
      account: ALICE,
      queried_at: "2026-07-20T00:00:00.000Z",
      subnets: [
        {
          netuid: 1,
          entries: [
            {
              child: BOB,
              proportion: "9223372036854775807",
              proportion_fraction: 0.5,
            },
          ],
        },
      ],
    });
    const res = await runChildren(ALICE);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      `/api/v1/accounts/${ALICE}/children`,
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(res.data).toMatchObject({
      account: ALICE,
      schema_version: 1,
      queried_at: "2026-07-20T00:00:00.000Z",
    });
    expect(res.data.subnets).toEqual([
      {
        netuid: 1,
        entries: [
          {
            child: BOB,
            proportion: "9223372036854775807",
            proportion_fraction: 0.5,
          },
        ],
      },
    ]);
  });

  it("preserves subnets: null as an RPC failure (distinct from empty)", async () => {
    resolveWith(`/api/v1/accounts/${ALICE}/children`, {
      account: ALICE,
      subnets: null,
    });
    const res = await runChildren(ALICE);
    expect(res.data.subnets).toBeNull();
  });

  it("drops incomplete entries and degrades junk payloads to an empty graph", async () => {
    resolveWith(`/api/v1/accounts/${ALICE}/children`, {
      account: ALICE,
      subnets: [
        { netuid: 1, entries: [{ child: BOB }] }, // missing proportion
        { netuid: "x", entries: [] },
        "not-a-subnet",
      ],
    });
    const res = await runChildren(ALICE);
    expect(res.data.subnets).toEqual([]);
  });
});

describe("accountParentsQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("hits the parents route and preserves a well-formed subnet row", async () => {
    resolveWith(`/api/v1/accounts/${ALICE}/parents`, {
      schema_version: 1,
      account: ALICE,
      subnets: [
        {
          netuid: 18,
          entries: [
            {
              parent: BOB,
              proportion: "18446744073709551615",
              proportion_fraction: 1,
            },
          ],
        },
      ],
    });
    const res = await runParents(ALICE);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      `/api/v1/accounts/${ALICE}/parents`,
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(res.data.subnets).toEqual([
      {
        netuid: 18,
        entries: [
          {
            parent: BOB,
            proportion: "18446744073709551615",
            proportion_fraction: 1,
          },
        ],
      },
    ]);
  });

  it("preserves subnets: null as an RPC failure", async () => {
    resolveWith(`/api/v1/accounts/${ALICE}/parents`, { account: ALICE, subnets: null });
    const res = await runParents(ALICE);
    expect(res.data.subnets).toBeNull();
  });
});
