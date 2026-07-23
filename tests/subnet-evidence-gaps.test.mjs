import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import { handleRequest } from "../workers/api.mjs";

const env = createLocalArtifactEnv();
const get = (path) =>
  handleRequest(new Request(`https://metagraph.sh${path}`), env, {});

describe("per-subnet evidence route", () => {
  test("returns claims scoped to the requested netuid", async () => {
    const res = await get("/api/v1/subnets/7/evidence");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.netuid, 7);
    assert.equal(Array.isArray(body.data.claims), true);
    assert.equal(body.data.claims.length > 0, true);
    // Every generated claim is scoped to SN7, even when a surface/candidate
    // subject slug does not encode the authoritative netuid.
    assert.equal(
      body.data.claims.every((claim) => /\bSN7\b/.test(String(claim.claim))),
      true,
    );
  });

  test("paginates via the claims collection (limit)", async () => {
    const res = await get("/api/v1/subnets/7/evidence?limit=2");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.claims.length <= 2, true);
    assert.equal(body.meta.pagination.collection, "claims");
  });

  test("resolves through a slug alias (allways -> 7)", async () => {
    const res = await get("/api/v1/subnets/allways/evidence");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.netuid, 7);
  });

  test("a subnet with no claims still returns a valid empty payload", async () => {
    // netuid 0 (root) exists in the registry; the route must 200 with an array.
    const res = await get("/api/v1/subnets/0/evidence");
    assert.equal(res.status, 200);
    assert.equal(Array.isArray((await res.json()).data.claims), true);
  });
});

describe("per-subnet gaps route", () => {
  test("returns priorities and the enrichment queue for the netuid", async () => {
    const res = await get("/api/v1/subnets/7/gaps");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.netuid, 7);
    assert.equal(Array.isArray(body.data.priorities), true);
    assert.equal(Array.isArray(body.data.enrichment_queue), true);
    // priorities are queryable + scoped; enrichment_queue rides along.
    assert.equal(
      body.data.priorities.every((priority) => priority.netuid === 7),
      true,
    );
    assert.equal(
      body.data.enrichment_queue.every((entry) => entry.netuid === 7),
      true,
    );
  });

  test("resolves through a slug alias (allways -> 7)", async () => {
    const res = await get("/api/v1/subnets/allways/gaps");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.netuid, 7);
  });

  test("an unknown slug returns 404 subnet_not_found", async () => {
    const res = await get("/api/v1/subnets/not-a-real-subnet/gaps");
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "subnet_not_found");
  });
});
