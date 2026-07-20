import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { accountEntitiesQuery } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: `/api/v1/accounts/${ALICE}/entities`,
  });
}

async function runQuery(ss58: string) {
  const opts = accountEntitiesQuery(ss58);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("accountEntitiesQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("hits the entities route and passes through labels + ownership ties", async () => {
    resolveWith({
      schema_version: 1,
      ss58: ALICE,
      labels: [
        {
          name: "Binance Hot",
          category: "exchange",
          notes: "Exchange deposit coldkey",
          source_urls: ["https://example.com/label"],
        },
      ],
      ownership_tie_count: 1,
      ownership_ties: [
        {
          netuid: 18,
          role: "gained_ownership",
          block_number: 5_000_000,
          observed_at: "2026-07-01T00:00:00.000Z",
        },
      ],
    });
    const res = await runQuery(ALICE);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      `/api/v1/accounts/${ALICE}/entities`,
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(res.data).toMatchObject({
      ss58: ALICE,
      schema_version: 1,
      ownership_tie_count: 1,
    });
    expect(res.data.labels).toEqual([
      {
        name: "Binance Hot",
        category: "exchange",
        notes: "Exchange deposit coldkey",
        source_urls: ["https://example.com/label"],
      },
    ]);
    expect(res.data.ownership_ties).toEqual([
      {
        netuid: 18,
        role: "gained_ownership",
        block_number: 5_000_000,
        observed_at: "2026-07-01T00:00:00.000Z",
      },
    ]);
  });

  it("drops invalid categories / roles and coerces junk cells", async () => {
    resolveWith({
      ss58: ALICE,
      labels: [
        { name: "Ops", category: "not-a-category", notes: null, source_urls: [123, "https://ok"] },
        "not-a-label",
      ],
      ownership_ties: [
        { netuid: 1, role: "gained_ownership", block_number: "x" },
        { netuid: 2, role: "invented" },
      ],
    });
    const res = await runQuery(ALICE);
    expect(res.data.labels).toEqual([
      {
        name: "Ops",
        category: null,
        notes: null,
        source_urls: ["https://ok"],
      },
    ]);
    expect(res.data.ownership_ties).toEqual([
      {
        netuid: 1,
        role: "gained_ownership",
        block_number: null,
        observed_at: null,
      },
    ]);
    expect(res.data.ownership_tie_count).toBe(1);
  });

  it("degrades a cold / unlabeled account to empty arrays (never throws)", async () => {
    for (const raw of [{}, null, { labels: "x", ownership_ties: "y" }]) {
      resolveWith(raw);
      const res = await runQuery(ALICE);
      expect(res.data.ss58).toBe(ALICE);
      expect(res.data.labels).toEqual([]);
      expect(res.data.ownership_ties).toEqual([]);
      expect(res.data.ownership_tie_count).toBe(0);
    }
  });
});
