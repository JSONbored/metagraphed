import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { normalizeSubnetPrometheus, subnetPrometheusQuery } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/subnets/7/prometheus",
  });
}

async function runQuery(netuid: number, window?: string) {
  const opts = subnetPrometheusQuery(netuid, window);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("normalizeSubnetPrometheus", () => {
  it("passes a well-formed card through", () => {
    expect(
      normalizeSubnetPrometheus(7, {
        schema_version: 1,
        netuid: 7,
        window: "30d",
        observed_at: "2026-07-01T00:00:00Z",
        distinct_exporters: 3,
        announcements: 12,
        announcements_per_exporter: 4,
      }),
    ).toEqual({
      schema_version: 1,
      netuid: 7,
      window: "30d",
      observed_at: "2026-07-01T00:00:00Z",
      distinct_exporters: 3,
      announcements: 12,
      announcements_per_exporter: 4,
    });
  });

  it("degrades a cold / junk store to a schema-stable zeroed card", () => {
    for (const raw of [{}, null, "x", { distinct_exporters: "nope" }]) {
      const card = normalizeSubnetPrometheus(7, raw);
      expect(card.netuid).toBe(7);
      expect(card.distinct_exporters).toBe(0);
      expect(card.announcements).toBe(0);
      expect(card.announcements_per_exporter).toBeNull();
      expect(card.observed_at).toBeNull();
    }
  });

  it("coerces a junk average to null (never NaN)", () => {
    const card = normalizeSubnetPrometheus(7, {
      announcements: 1,
      announcements_per_exporter: { avg: 1 },
    });
    expect(card.announcements).toBe(1);
    expect(card.announcements_per_exporter).toBeNull();
  });
});

describe("subnetPrometheusQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("passes the window param and normalizes the card", async () => {
    resolveWith({ netuid: 7, window: "7d", distinct_exporters: 2, announcements: 6 });
    const res = await runQuery(7, "7d");
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/subnets/7/prometheus",
      expect.objectContaining({ params: { window: "7d" } }),
    );
    expect(res.data.announcements).toBe(6);
    expect(res.data.distinct_exporters).toBe(2);
  });

  it("defaults to the 30d window", async () => {
    resolveWith({});
    await runQuery(7);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/subnets/7/prometheus",
      expect.objectContaining({ params: { window: "30d" } }),
    );
  });
});
