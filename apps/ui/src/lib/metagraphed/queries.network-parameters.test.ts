import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { networkParametersQuery } from "./queries";
import { runQuery } from "./run-query";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/network/parameters",
  });
}

describe("networkParametersQuery (#6997)", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("hits /api/v1/network/parameters and passes a well-formed response through", async () => {
    resolveWith({
      tao_weight: 0.18,
      stake_threshold_tao: 1000,
      pending_childkey_cooldown_blocks: 7200,
      queried_at: "2026-07-20T12:00:00.000Z",
    });
    const res = await runQuery(networkParametersQuery());
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/network/parameters",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(res.data.tao_weight).toBe(0.18);
    expect(res.data.stake_threshold_tao).toBe(1000);
    expect(res.data.pending_childkey_cooldown_blocks).toBe(7200);
    expect(res.data.queried_at).toBe("2026-07-20T12:00:00.000Z");
  });

  it("nulls each field independently on its own RPC failure -- a partial response doesn't null the rest", async () => {
    // Mirrors the REST route's own contract: each field is independently
    // null on its own RPC failure, not an all-or-nothing degrade.
    resolveWith({
      tao_weight: null,
      stake_threshold_tao: 1000,
      pending_childkey_cooldown_blocks: 7200,
      queried_at: "2026-07-20T12:00:00.000Z",
    });
    const res = await runQuery(networkParametersQuery());
    expect(res.data.tao_weight).toBeNull();
    expect(res.data.stake_threshold_tao).toBe(1000);
    expect(res.data.pending_childkey_cooldown_blocks).toBe(7200);
  });

  it("keeps a real zero distinguishable from a failed (null) read", async () => {
    resolveWith({
      tao_weight: 0,
      stake_threshold_tao: 0,
      pending_childkey_cooldown_blocks: 0,
      queried_at: "2026-07-20T12:00:00.000Z",
    });
    const res = await runQuery(networkParametersQuery());
    expect(res.data.tao_weight).toBe(0);
    expect(res.data.stake_threshold_tao).toBe(0);
    expect(res.data.pending_childkey_cooldown_blocks).toBe(0);
  });

  it("degrades junk / missing input to an all-null shape, never NaN or a throw", async () => {
    for (const raw of [{}, null, undefined, "nope", { tao_weight: "many" }]) {
      resolveWith(raw);
      const res = await runQuery(networkParametersQuery());
      expect(res.data.tao_weight).toBeNull();
      expect(res.data.stake_threshold_tao).toBeNull();
      expect(res.data.pending_childkey_cooldown_blocks).toBeNull();
      expect(res.data.queried_at).toBeNull();
    }
  });
});
