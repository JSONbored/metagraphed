// #1001 — serve-time contract-version enforcement. When the Worker serves a
// stored artifact built under an OLDER contract than the live one (the silent
// drift that ships when a deploy bumps the contract but R2/committed data hasn't
// been rebuilt yet), it must surface meta.stale_contract + the
// x-metagraph-stale-contract header. We simulate the drift by pinning a FUTURE
// live contract version, so every current artifact lags it.

import { describe, expect, it } from "vitest";
import { handleRequest } from "../workers/api.ts";
import { contractStaleness } from "../workers/responses.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";

const ARTIFACT_ROUTE = "https://metagraph.sh/api/v1/subnets";

describe("serve-time contract staleness (#1001)", () => {
  function parseExposeHeader(response: Response) {
    return new Set(
      (response.headers.get("access-control-expose-headers") || "")
        .split(",")
        .map((name: string) => name.trim().toLowerCase())
        .filter(Boolean),
    );
  }

  it("surfaces stale_contract on meta + header when the artifact lags the live contract", async () => {
    const env = {
      ...createLocalArtifactEnv(),
      METAGRAPH_CONTRACT_VERSION: "2099-01-01.1",
    };
    const res = await handleRequest(
      new Request(ARTIFACT_ROUTE),
      env as unknown as Env,
      {},
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.meta.stale_contract).toBeTruthy();
    expect(body.meta.stale_contract.live).toBe("2099-01-01.1");
    expect(typeof body.meta.stale_contract.built_under).toBe("string");
    expect(body.meta.stale_contract.built_under).not.toBe("2099-01-01.1");
    // The header mirrors meta for monitoring/CDN alarms.
    expect(res.headers.get("x-metagraph-stale-contract")).toBe(
      body.meta.stale_contract.built_under,
    );
    const staleContractHeader = "x-metagraph-stale-contract";
    const exposedHeaders = parseExposeHeader(res);
    const emittedMetagraphHeaders = [...res.headers.entries()]
      .map(([name]) => name.toLowerCase())
      .filter((name) => name.startsWith("x-metagraph-"));

    expect(exposedHeaders.has(staleContractHeader)).toBe(true);
    expect(emittedMetagraphHeaders.length).toBeGreaterThan(0);
    for (const name of emittedMetagraphHeaders) {
      expect(exposedHeaders.has(name)).toBe(true);
    }
  });

  it("omits stale_contract when the artifact matches the live contract", async () => {
    const env = createLocalArtifactEnv();
    const res = await handleRequest(
      new Request(ARTIFACT_ROUTE),
      env as unknown as Env,
      {},
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.meta.stale_contract).toBeUndefined();
    expect(res.headers.get("x-metagraph-stale-contract")).toBeNull();
  });

  it("orders contract versions by date then numeric revision", () => {
    const live = (v: string) =>
      ({ METAGRAPH_CONTRACT_VERSION: v }) as unknown as Env;
    // older date -> stale
    expect(contractStaleness(live("2026-06-07.1"), "2026-06-06.9")).toEqual({
      built_under: "2026-06-06.9",
      live: "2026-06-07.1",
    });
    // same date, lower revision -> stale (numeric, not lexicographic: .2 < .10)
    expect(contractStaleness(live("2026-06-06.10"), "2026-06-06.2")).toEqual({
      built_under: "2026-06-06.2",
      live: "2026-06-06.10",
    });
    // equal -> not stale
    expect(contractStaleness(live("2026-06-06.1"), "2026-06-06.1")).toBeNull();
    // newer artifact than live -> not flagged
    expect(contractStaleness(live("2026-06-06.1"), "2026-06-07.1")).toBeNull();
    // missing -> not flagged
    expect(contractStaleness(live("2026-06-06.1"), undefined)).toBeNull();
  });
});
