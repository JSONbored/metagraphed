import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { normalizeRpcEndpoint, normalizeRpcEndpointsSummary, rpcEndpointsQuery } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown, meta: ApiResult<unknown>["meta"] = {}): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta,
    url: "/api/v1/rpc/endpoints",
  });
}

function runQuery() {
  const opts = rpcEndpointsQuery();
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as never);
}

describe("normalizeRpcEndpointsSummary", () => {
  it("maps rollup counts from the artifact summary block", () => {
    const summary = normalizeRpcEndpointsSummary({
      endpoint_count: 12,
      archive_supported_count: 4,
      by_kind: { "subtensor-rpc": 8, "subtensor-wss": 4 },
      by_provider: { opentensor: 6 },
      by_status: { ok: 10, degraded: 2 },
    });
    expect(summary).toEqual({
      endpoint_count: 12,
      archive_supported_count: 4,
      by_kind: { "subtensor-rpc": 8, "subtensor-wss": 4 },
      by_provider: { opentensor: 6 },
      by_status: { ok: 10, degraded: 2 },
    });
  });
});

describe("normalizeRpcEndpoint", () => {
  it("maps wire status to UI health and preserves RPC-specific fields", () => {
    const row = normalizeRpcEndpoint({
      id: "finney-rpc-1",
      netuid: 0,
      chain: "bittensor",
      kind: "subtensor-rpc",
      url: "https://rpc.example",
      provider: "opentensor",
      status: "degraded",
      classification: "live",
      authority: "official",
      latency_ms: 120,
      latest_block: 4_200_000,
      archive_support: true,
      methods_supported: { chain_getBlock: true },
    });
    expect(row.health).toBe("warn");
    expect(row.latest_block).toBe(4_200_000);
    expect(row.archive_support).toBe(true);
  });
});

describe("rpcEndpointsQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("unwraps endpoints and summary from the keyed artifact payload", async () => {
    resolveWith(
      {
        endpoints: [
          {
            id: "wss-1",
            netuid: 0,
            chain: "bittensor",
            kind: "subtensor-wss",
            url: "wss://entrypoint.example",
            provider: "community",
            status: "ok",
          },
        ],
        summary: {
          endpoint_count: 1,
          archive_supported_count: 0,
          by_status: { ok: 1 },
        },
        generated_at: "2026-07-08T00:00:00.000Z",
      },
      { generated_at: "2026-07-08T00:00:00.000Z", source: "live-cron-prober" },
    );

    const res = await runQuery();
    expect(res.data).toHaveLength(1);
    expect(res.data[0]?.kind).toBe("subtensor-wss");
    expect(res.summary?.endpoint_count).toBe(1);
    expect(res.summary?.by_status?.ok).toBe(1);
    expect(res.meta?.source).toBe("live-cron-prober");
  });
});
