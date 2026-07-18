import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";
import { DOMAIN_TAGS } from "../src/domain-tags.mjs";

describe("GET /api/v1/domains", () => {
  const env = createLocalArtifactEnv();
  const get = async (path) => {
    const res = await handleRequest(
      new Request(`https://api.metagraph.sh${path}`),
      env,
      {},
    );
    return { status: res.status, body: await res.json() };
  };

  test("returns one entry per domain tag in the fixed taxonomy", async () => {
    const { status, body } = await get("/api/v1/domains");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.domain_count, DOMAIN_TAGS.length);
    assert.equal(body.data.domains.length, DOMAIN_TAGS.length);
    assert.deepEqual(
      body.data.domains.map((d) => d.domain).sort(),
      [...DOMAIN_TAGS].sort(),
    );
    assert.equal(body.meta.artifact_path, "/metagraph/domains.json");
  });

  test("every domain entry matches the DomainSummaryArtifact shape", async () => {
    const { body } = await get("/api/v1/domains");
    for (const entry of body.data.domains) {
      assert.equal(typeof entry.subnet_count, "number");
      assert.ok(Array.isArray(entry.netuids));
      assert.equal(entry.netuids.length, entry.subnet_count);
      // netuids are sorted ascending.
      const sorted = [...entry.netuids].sort((a, b) => a - b);
      assert.deepEqual(entry.netuids, sorted);
    }
  });

  test("rejects an unsupported query param", async () => {
    const { status, body } = await get("/api/v1/domains?bogus=1");
    assert.equal(status, 400);
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.meta.parameter, "bogus");
  });

  // Both the subnets index and the economics artifact miss (readArtifact
  // returns {ok:false}) -- every domain still gets a schema-stable empty
  // rollup rather than a thrown error, matching every other live-composition
  // route in this codebase.
  test("degrades to an empty overview when both artifacts are cold", async () => {
    const coldEnv = createLocalArtifactEnv({
      METAGRAPH_ARCHIVE: {
        async get() {
          return null;
        },
      },
    });
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/domains"),
      coldEnv,
      {},
    );
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.data.domain_count, DOMAIN_TAGS.length);
    for (const entry of body.data.domains) {
      assert.equal(entry.subnet_count, 0);
    }
  });

  // The committed economics.json artifact itself lacking captured_at (a
  // malformed/legacy write) -- generated_at falls back to null rather than
  // leaking `undefined` into the response, without ever throwing.
  test("tolerates a committed economics artifact with no captured_at", async () => {
    const noTimestampEnv = createLocalArtifactEnv({
      METAGRAPH_ARCHIVE: {
        async get(key) {
          if (!key.endsWith("economics.json")) return null;
          return {
            async json() {
              return {
                schema_version: 1,
                subnets: [{ netuid: 1, total_stake_tao: 5, emission_share: 1 }],
              };
            },
          };
        },
      },
    });
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/domains"),
      noTimestampEnv,
      {},
    );
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.meta.generated_at, null);
  });

  // resolveLiveEconomics' KV-primary path (live-kv source, ahead of the R2
  // fallback the tests above all exercise) -- a fresh, on-contract, integrity-
  // passing blob (emission_share summing to ~1) served from METAGRAPH_CONTROL.
  test("prefers a fresh live-KV economics blob over the R2 fallback", async () => {
    const liveEnv = createLocalArtifactEnv({
      METAGRAPH_CONTROL: {
        async get(key) {
          if (key !== "economics:current") return null;
          return {
            schema_version: 1,
            captured_at: new Date().toISOString(),
            summary: { with_economics_count: 1 },
            subnets: [{ netuid: 1, total_stake_tao: 999, emission_share: 1 }],
          };
        },
      },
    });
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/domains"),
      liveEnv,
      {},
    );
    const body = await res.json();
    assert.equal(res.status, 200);
    const domainWithSubnet1 = body.data.domains.find((d) =>
      d.netuids.includes(1),
    );
    assert.ok(
      domainWithSubnet1,
      "netuid 1 should appear in at least one domain",
    );
    assert.equal(domainWithSubnet1.total_stake_tao, 999);
  });
});

describe("GET /api/v1/domains/{tag}/summary", () => {
  const env = createLocalArtifactEnv();
  const get = async (path) => {
    const res = await handleRequest(
      new Request(`https://api.metagraph.sh${path}`),
      env,
      {},
    );
    return { status: res.status, body: await res.json() };
  };

  test("returns one domain tag's own rollup, matching /api/v1/domains' own entry for it", async () => {
    const [{ body: overview }, { status, body }] = await Promise.all([
      get("/api/v1/domains"),
      get("/api/v1/domains/inference/summary"),
    ]);
    assert.equal(status, 200);
    assert.equal(body.data.domain, "inference");
    assert.ok(body.data.subnet_count > 0);
    const fromOverview = overview.data.domains.find(
      (d) => d.domain === "inference",
    );
    assert.deepEqual(body.data, fromOverview);
    assert.equal(
      body.meta.artifact_path,
      "/metagraph/domains/inference/summary.json",
    );
  });

  test("rejects an unknown domain tag as a 400, not a 404", async () => {
    const { status, body } = await get(
      "/api/v1/domains/not-a-real-tag/summary",
    );
    assert.equal(status, 400);
    assert.equal(body.error.code, "invalid_request");
    assert.equal(body.meta.parameter, "tag");
  });

  test("rejects an unsupported query param", async () => {
    const { status, body } = await get(
      "/api/v1/domains/inference/summary?bogus=1",
    );
    assert.equal(status, 400);
    assert.equal(body.meta.parameter, "bogus");
  });
});
