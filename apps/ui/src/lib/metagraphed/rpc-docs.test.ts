import { describe, expect, it } from "vitest";
import {
  RPC_API_SURFACES,
  RPC_API_SURFACE_COUNT,
  RPC_DOCS_DENIED_PREFIXES,
  RPC_DOCS_MAX_ATTEMPTS,
  RPC_DOCS_MAX_BODY_BYTES,
  RPC_DOCS_MAX_STATE_QUERY_KEYS_PAGE_SIZE,
  RPC_DOCS_MAX_STATE_QUERY_RESPONSE_BYTES,
  RPC_DOCS_NETWORKS,
  RPC_DOCS_SAFE_METHODS,
  RPC_DOCS_SAFE_METHOD_COUNT,
  RPC_DOCS_STATE_QUERY_METHODS,
  RPC_ENDPOINTS_PATH,
  RPC_POOLS_PATH,
  RPC_USAGE_PATH,
  buildRpcCurlExample,
  buildRpcLimitRows,
  formatRpcByteBudget,
  rpcProxyPath,
} from "./rpc-docs";

describe("rpc docs reference (#3515)", () => {
  it("keeps Worker-aligned limit constants", () => {
    expect(RPC_DOCS_MAX_BODY_BYTES).toBe(64 * 1024);
    expect(RPC_DOCS_MAX_STATE_QUERY_RESPONSE_BYTES).toBe(256 * 1024);
    expect(RPC_DOCS_MAX_STATE_QUERY_KEYS_PAGE_SIZE).toBe(250);
    expect(RPC_DOCS_MAX_ATTEMPTS).toBe(3);
  });

  it("documents networks, catalog surfaces, and method allowlists without duplicates", () => {
    expect([...RPC_DOCS_NETWORKS]).toEqual(["finney", "test"]);
    expect(RPC_API_SURFACES).toHaveLength(RPC_API_SURFACE_COUNT);
    expect(RPC_DOCS_SAFE_METHODS).toHaveLength(RPC_DOCS_SAFE_METHOD_COUNT);
    expect(RPC_DOCS_STATE_QUERY_METHODS).toContain("state_getStorage");
    expect(RPC_DOCS_DENIED_PREFIXES).toContain("author_");
    const paths = RPC_API_SURFACES.map((s) => s.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toContain(RPC_POOLS_PATH);
    expect(paths).toContain(RPC_ENDPOINTS_PATH);
    expect(paths).toContain(RPC_USAGE_PATH);
  });

  it("formats byte budgets as KiB when divisible by 1024", () => {
    expect(formatRpcByteBudget(64 * 1024)).toBe("64 KiB");
    expect(formatRpcByteBudget(256 * 1024)).toBe("256 KiB");
    expect(formatRpcByteBudget(100)).toBe("100 B");
    expect(formatRpcByteBudget(Number.NaN)).toBe("—");
  });

  it("builds a limits table covering rate, body, state-query, and failover", () => {
    const rows = buildRpcLimitRows();
    const labels = rows.map((r) => r.label);
    expect(labels).toEqual([
      "Rate limit",
      "State-query rate",
      "Max POST body",
      "Max state-query response",
      "state_getKeysPaged page",
      "Failover attempts",
    ]);
    expect(rows[0]?.value).toContain("100");
    expect(rows[1]?.value).toContain("20");
  });

  it("builds a curl example against the network proxy path", () => {
    expect(rpcProxyPath("finney")).toBe("/rpc/v1/finney");
    expect(rpcProxyPath("test")).toBe("/rpc/v1/test");
    const curl = buildRpcCurlExample("https://api.metagraph.sh", "finney");
    expect(curl).toContain("POST");
    expect(curl).toContain("https://api.metagraph.sh/rpc/v1/finney");
    expect(curl).toContain("chain_getHeader");
  });
});
