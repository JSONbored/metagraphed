import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { accountDeregistrationsQuery, normalizeAccountDeregistrations } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);
const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: `/api/v1/accounts/${SS58}/deregistrations`,
  });
}

async function runQuery(ss58: string, window?: string) {
  const opts = accountDeregistrationsQuery(ss58, window);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("normalizeAccountDeregistrations", () => {
  it("passes a well-formed card through", () => {
    expect(
      normalizeAccountDeregistrations(SS58, {
        schema_version: 1,
        address: SS58,
        window: "30d",
        total_deregistrations: 5,
        subnet_count: 2,
        concentration: 0.68,
        dominant_netuid: 1,
        subnets: [
          {
            netuid: 1,
            deregistrations: 4,
            first_deregistered_at: "2026-06-01T00:00:00.000Z",
            last_deregistered_at: "2026-06-02T00:00:00.000Z",
          },
          {
            netuid: 7,
            deregistrations: 1,
            first_deregistered_at: "2026-06-03T00:00:00.000Z",
            last_deregistered_at: "2026-06-03T00:00:00.000Z",
          },
        ],
      }),
    ).toEqual({
      schema_version: 1,
      address: SS58,
      window: "30d",
      total_deregistrations: 5,
      subnet_count: 2,
      concentration: 0.68,
      dominant_netuid: 1,
      subnets: [
        {
          netuid: 1,
          deregistrations: 4,
          first_deregistered_at: "2026-06-01T00:00:00.000Z",
          last_deregistered_at: "2026-06-02T00:00:00.000Z",
        },
        {
          netuid: 7,
          deregistrations: 1,
          first_deregistered_at: "2026-06-03T00:00:00.000Z",
          last_deregistered_at: "2026-06-03T00:00:00.000Z",
        },
      ],
    });
  });

  it("degrades a cold / junk store to a schema-stable zeroed card", () => {
    for (const raw of [{}, null, "x", { total_deregistrations: "nope" }]) {
      const card = normalizeAccountDeregistrations(SS58, raw);
      expect(card.address).toBe(SS58);
      expect(card.total_deregistrations).toBe(0);
      expect(card.subnet_count).toBe(0);
      expect(card.concentration).toBeNull();
      expect(card.subnets).toEqual([]);
    }
  });
});

describe("accountDeregistrationsQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("passes the window param and normalizes the card", async () => {
    resolveWith({ address: SS58, window: "7d", total_deregistrations: 2, subnet_count: 1 });
    const res = await runQuery(SS58, "7d");
    expect(mockedApiFetch).toHaveBeenCalledWith(
      `/api/v1/accounts/${SS58}/deregistrations`,
      expect.objectContaining({ params: { window: "7d" } }),
    );
    expect(res.data.total_deregistrations).toBe(2);
    expect(res.data.subnet_count).toBe(1);
  });

  it("defaults to the 30d window", async () => {
    resolveWith({});
    await runQuery(SS58);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      `/api/v1/accounts/${SS58}/deregistrations`,
      expect.objectContaining({ params: { window: "30d" } }),
    );
  });
});
