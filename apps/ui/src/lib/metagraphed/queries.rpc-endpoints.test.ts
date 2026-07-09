import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { rpcEndpointsQuery } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown, meta: Record<string, unknown> = {}): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: meta as ApiResult<unknown>["meta"],
    url: "/api/v1/rpc/endpoints",
  });
}

async function runQuery() {
  const opts = rpcEndpointsQuery();
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("rpcEndpointsQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("unwraps both the endpoints array and the summary rollup (fetchList alone would drop summary)", async () => {
    resolveWith({
      contract_version: "2026-06-06.1",
      generated_at: "2026-07-08T21:50:41.021Z",
      endpoints: [{ id: "onfinality-finney-rpc", kind: "subtensor-rpc", status: "ok" }],
      summary: { endpoint_count: 9, archive_supported_count: 4, by_status: { ok: 4 } },
    });

    const res = await runQuery();

    expect(res.data.endpoints).toHaveLength(1);
    expect(res.data.endpoints[0]?.id).toBe("onfinality-finney-rpc");
    expect(res.data.summary).toEqual({
      endpoint_count: 9,
      archive_supported_count: 4,
      by_status: { ok: 4 },
    });
  });

  it("drops a row with no id (not just passing junk through)", async () => {
    resolveWith({
      endpoints: [{ kind: "subtensor-rpc" }, { id: "real-one" }],
      summary: null,
    });

    const res = await runQuery();

    expect(res.data.endpoints).toHaveLength(1);
    expect(res.data.endpoints[0]?.id).toBe("real-one");
  });

  it("degrades a cold/junk store to a schema-stable shape, never throws", async () => {
    for (const raw of [{}, null, "x", { endpoints: "nope", summary: "nope" }]) {
      resolveWith(raw);
      const res = await runQuery();
      expect(res.data.endpoints).toEqual([]);
      expect(res.data.summary).toBeNull();
    }
  });

  it("passes generated_at through via meta, matching the rpcPoolsQuery freshness convention", async () => {
    resolveWith({ endpoints: [], summary: null }, { generated_at: "2026-07-08T21:50:41.021Z" });
    const res = await runQuery();
    expect(res.meta?.generated_at).toBe("2026-07-08T21:50:41.021Z");
  });
});
