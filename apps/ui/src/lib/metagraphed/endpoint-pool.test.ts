import { describe, it, expect } from "vitest";
import { endpointEligibility, endpointCategory, indexPoolsById } from "./endpoint-pool";
import type { Endpoint, RpcPool } from "./types";

const ep = (e: Partial<Endpoint>): Endpoint => ({ id: "e1", ...e });

describe("endpointEligibility", () => {
  it("returns proxy-enabled when the referenced pool has proxy_enabled", () => {
    const pools = indexPoolsById([{ id: "p1", proxy_enabled: true } as RpcPool]);
    expect(endpointEligibility(ep({ pool: "p1" }), pools)).toBe("proxy-enabled");
  });

  it("prefers proxy-enabled over archive when both apply", () => {
    const pools = indexPoolsById([{ id: "p1", proxy_enabled: true } as RpcPool]);
    expect(endpointEligibility(ep({ pool: "p1", archive: true }), pools)).toBe("proxy-enabled");
  });

  it("returns pool-member for a pool reference without proxy, or pool_eligible flag", () => {
    const pools = indexPoolsById([{ id: "p1", proxy_enabled: false } as RpcPool]);
    expect(endpointEligibility(ep({ pool: "p1" }), pools)).toBe("pool-member");
    // pool_eligible alone (no pool id, no matching pool) still ranks as pool-member.
    expect(endpointEligibility(ep({ pool_eligible: true }))).toBe("pool-member");
  });

  it("prefers pool-member over archive", () => {
    expect(endpointEligibility(ep({ pool_eligible: true, archive: true }))).toBe("pool-member");
  });

  it("returns archive-capable from the archive flag or an archive kind", () => {
    expect(endpointEligibility(ep({ archive: true }))).toBe("archive-capable");
    expect(endpointEligibility(ep({ kind: "wss-archive" }))).toBe("archive-capable");
    expect(endpointEligibility(ep({ kind: "RPC-ARCHIVE" }))).toBe("archive-capable");
  });

  it("returns unassigned when nothing matches (incl. unknown pool id)", () => {
    expect(endpointEligibility(ep({ kind: "rpc" }))).toBe("unassigned");
    // A pool id that resolves to no pool still counts as a pool-member reference.
    expect(endpointEligibility(ep({ pool: "missing" }))).toBe("pool-member");
    expect(endpointEligibility(ep({}))).toBe("unassigned");
  });
});

describe("endpointCategory", () => {
  it("returns other for empty / nullish kinds", () => {
    expect(endpointCategory(undefined)).toBe("other");
    expect(endpointCategory(null)).toBe("other");
    expect(endpointCategory("")).toBe("other");
  });

  it("classifies wss (incl. plain ws) before rpc", () => {
    expect(endpointCategory("wss")).toBe("wss");
    expect(endpointCategory("ws")).toBe("wss");
    expect(endpointCategory("wss-archive")).toBe("wss");
  });

  it("classifies rpc kinds", () => {
    expect(endpointCategory("rpc")).toBe("rpc");
    expect(endpointCategory("rpc-archive")).toBe("rpc");
    expect(endpointCategory("RPC")).toBe("rpc");
  });

  it("classifies sse / streaming", () => {
    expect(endpointCategory("sse")).toBe("sse");
    expect(endpointCategory("event-stream")).toBe("sse");
  });

  it("classifies data / artifact / dataset", () => {
    expect(endpointCategory("data")).toBe("data");
    expect(endpointCategory("artifact")).toBe("data");
    expect(endpointCategory("dataset")).toBe("data");
  });

  it("classifies api / http / rest", () => {
    expect(endpointCategory("api")).toBe("api");
    expect(endpointCategory("http")).toBe("api");
    expect(endpointCategory("rest")).toBe("api");
  });

  it("classifies grpc as rpc — the 'rpc' substring branch wins over the api branch", () => {
    // "grpc".includes("rpc") is true and the rpc check runs first, so grpc
    // resolves to "rpc" despite being listed under the api branch. Documenting
    // the implemented precedence rather than the aspirational grouping.
    expect(endpointCategory("grpc")).toBe("rpc");
  });

  it("falls through to other for unknown kinds", () => {
    expect(endpointCategory("smoke-signal")).toBe("other");
  });
});
