import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import {
  accountPrometheusQuery,
  accountServingQuery,
  normalizeAccountPrometheus,
  normalizeAccountServing,
} from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);
const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

async function runServingQuery(ss58: string, window?: string) {
  const opts = accountServingQuery(ss58, window);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

async function runPrometheusQuery(ss58: string, window?: string) {
  const opts = accountPrometheusQuery(ss58, window);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("normalizeAccountServing", () => {
  it("passes a well-formed card through", () => {
    expect(
      normalizeAccountServing(SS58, {
        schema_version: 1,
        address: SS58,
        window: "30d",
        total_announcements: 12,
        subnet_count: 2,
        concentration: 0.56,
        dominant_netuid: 1,
        subnets: [
          {
            netuid: 1,
            announcements: 8,
            first_served_at: "2026-06-01T00:00:00.000Z",
            last_served_at: "2026-06-15T00:00:00.000Z",
          },
        ],
      }),
    ).toMatchObject({
      total_announcements: 12,
      subnet_count: 2,
      subnets: [{ netuid: 1, announcements: 8 }],
    });
  });

  it("degrades a cold / junk store to a schema-stable zeroed card", () => {
    for (const raw of [{}, null, "x", { total_announcements: "nope" }]) {
      const card = normalizeAccountServing(SS58, raw);
      expect(card.address).toBe(SS58);
      expect(card.total_announcements).toBe(0);
      expect(card.subnet_count).toBe(0);
      expect(card.subnets).toEqual([]);
    }
  });
});

describe("normalizeAccountPrometheus", () => {
  it("passes a well-formed card through", () => {
    expect(
      normalizeAccountPrometheus(SS58, {
        schema_version: 1,
        address: SS58,
        window: "30d",
        total_announcements: 5,
        subnet_count: 1,
        subnets: [
          {
            netuid: 7,
            announcements: 5,
            first_announced_at: "2026-06-20T00:00:00.000Z",
            last_announced_at: "2026-06-20T00:00:00.000Z",
          },
        ],
      }),
    ).toMatchObject({
      total_announcements: 5,
      subnet_count: 1,
      subnets: [{ netuid: 7, announcements: 5 }],
    });
  });

  it("degrades a cold / junk store to a schema-stable zeroed card", () => {
    for (const raw of [{}, null, "x", { total_announcements: "nope" }]) {
      const card = normalizeAccountPrometheus(SS58, raw);
      expect(card.address).toBe(SS58);
      expect(card.total_announcements).toBe(0);
      expect(card.subnet_count).toBe(0);
      expect(card.subnets).toEqual([]);
    }
  });
});

describe("accountServingQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("passes the window param and normalizes the card", async () => {
    mockedApiFetch.mockResolvedValue({
      data: { address: SS58, window: "7d", total_announcements: 3, subnet_count: 1 },
      meta: {} as ApiResult<unknown>["meta"],
      url: `/api/v1/accounts/${SS58}/serving`,
    });
    const res = await runServingQuery(SS58, "7d");
    expect(mockedApiFetch).toHaveBeenCalledWith(
      `/api/v1/accounts/${SS58}/serving`,
      expect.objectContaining({ params: { window: "7d" } }),
    );
    expect(res.data.total_announcements).toBe(3);
  });

  it("defaults to the 30d window", async () => {
    mockedApiFetch.mockResolvedValue({
      data: {},
      meta: {} as ApiResult<unknown>["meta"],
      url: `/api/v1/accounts/${SS58}/serving`,
    });
    await runServingQuery(SS58);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      `/api/v1/accounts/${SS58}/serving`,
      expect.objectContaining({ params: { window: "30d" } }),
    );
  });
});

describe("accountPrometheusQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("passes the window param and normalizes the card", async () => {
    mockedApiFetch.mockResolvedValue({
      data: { address: SS58, window: "7d", total_announcements: 2, subnet_count: 1 },
      meta: {} as ApiResult<unknown>["meta"],
      url: `/api/v1/accounts/${SS58}/prometheus`,
    });
    const res = await runPrometheusQuery(SS58, "7d");
    expect(mockedApiFetch).toHaveBeenCalledWith(
      `/api/v1/accounts/${SS58}/prometheus`,
      expect.objectContaining({ params: { window: "7d" } }),
    );
    expect(res.data.total_announcements).toBe(2);
  });

  it("defaults to the 30d window", async () => {
    mockedApiFetch.mockResolvedValue({
      data: {},
      meta: {} as ApiResult<unknown>["meta"],
      url: `/api/v1/accounts/${SS58}/prometheus`,
    });
    await runPrometheusQuery(SS58);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      `/api/v1/accounts/${SS58}/prometheus`,
      expect.objectContaining({ params: { window: "30d" } }),
    );
  });
});
