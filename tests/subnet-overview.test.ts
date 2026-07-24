import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import { handleRequest } from "../workers/api.ts";

const env = createLocalArtifactEnv();
const get = (path: string) =>
  handleRequest(
    new Request(`https://metagraph.sh${path}`),
    env as unknown as Env,
    {},
  );

describe("per-subnet overview route", () => {
  test("composes profile + health + curation + gaps + counts in one call", async () => {
    const res = await get("/api/v1/subnets/7/overview");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.netuid, 7);
    assert.equal(body.data.profile.netuid, 7);
    assert.equal(typeof body.data.health, "object");
    assert.equal(typeof body.data.counts.surfaces, "number");
    assert.equal(typeof body.data.counts.endpoints, "number");
    assert.equal(Array.isArray(body.data.gap_priorities), true);
  });

  test("resolves through a slug alias (allways -> 7)", async () => {
    const res = await get("/api/v1/subnets/allways/overview");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.netuid, 7);
  });

  test("an unknown slug returns 404 subnet_not_found", async () => {
    const res = await get("/api/v1/subnets/not-a-real-subnet/overview");
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "subnet_not_found");
  });
});

describe("registry summary route", () => {
  test("returns registry-wide stats, top subnets, and recent changes", async () => {
    const res = await get("/api/v1/registry/summary");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.data.subnet_count, "number");
    assert.equal(body.data.subnet_count > 0, true);
    assert.equal(Array.isArray(body.data.top_subnets), true);
    assert.equal(body.data.top_subnets.length <= 10, true);
    assert.equal(typeof body.data.counts.surfaces, "number");
    assert.equal(typeof body.data.recent_changes, "object");
    // top_subnets is sorted by completeness_score descending.
    const scores = body.data.top_subnets.map(
      (s: { completeness_score: number }) => s.completeness_score,
    );
    assert.deepEqual(
      scores,
      [...scores].sort((a, b) => b - a),
    );
  });
});
