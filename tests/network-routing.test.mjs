import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

const ORIGIN = "https://api.metagraph.sh";

async function get(env, pathname, init) {
  const res = await handleRequest(
    new Request(`${ORIGIN}${pathname}`, init),
    env,
    {},
  );
  let body;
  try {
    body = JSON.parse(await res.clone().text());
  } catch {
    body = null;
  }
  return { res, body };
}

describe("multi-network routing prefix (Phase 1)", () => {
  test("mainnet + finney aliases serve the same data as the bare path", async () => {
    const env = createLocalArtifactEnv();
    const bare = await get(env, "/api/v1/subnets");
    const mainnet = await get(env, "/api/v1/mainnet/subnets");
    const finney = await get(env, "/api/v1/finney/subnets");

    assert.equal(bare.res.status, 200);
    assert.equal(mainnet.res.status, 200);
    assert.equal(finney.res.status, 200);

    const count = (b) => b.data?.subnets?.length;
    assert.ok(count(bare.body) > 0);
    assert.equal(count(mainnet.body), count(bare.body));
    assert.equal(count(finney.body), count(bare.body));
    // The alias resolves to the unprefixed mainnet artifact key.
    assert.equal(mainnet.body.meta.artifact_path, "/metagraph/subnets.json");
  });

  test("bare paths are unchanged (no prefix → implicit mainnet)", async () => {
    const env = createLocalArtifactEnv();
    const { res, body } = await get(env, "/api/v1/coverage");
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.meta.artifact_path, "/metagraph/coverage.json");
  });

  test("a friendly per-subnet route still resolves under the mainnet alias", async () => {
    const env = createLocalArtifactEnv();
    const bare = await get(env, "/api/v1/subnets/7");
    const aliased = await get(env, "/api/v1/mainnet/subnets/7");
    assert.equal(bare.res.status, 200);
    assert.equal(aliased.res.status, 200);
    assert.equal(aliased.body.data?.subnet?.netuid, bare.body.data?.subnet?.netuid);
  });

  test("testnet route 404s cleanly when no testnet data is published, targeting the partitioned key", async () => {
    const env = createLocalArtifactEnv();
    const { res, body } = await get(env, "/api/v1/testnet/subnets");
    assert.equal(res.status, 404);
    assert.match(body.meta.artifact_path, /\/metagraph\/testnet\//);
  });

  test("local network route 404s cleanly", async () => {
    const env = createLocalArtifactEnv();
    const { res } = await get(env, "/api/v1/local/coverage");
    assert.equal(res.status, 404);
  });

  test("mainnet-only dynamic routes 404 under a network prefix, naming the network", async () => {
    const env = createLocalArtifactEnv();
    const semantic = await get(env, "/api/v1/testnet/search/semantic");
    assert.equal(semantic.res.status, 404);
    assert.equal(semantic.body.meta.network, "testnet");

    const leaderboards = await get(
      env,
      "/api/v1/testnet/registry/leaderboards",
    );
    assert.equal(leaderboards.res.status, 404);

    // Numeric per-subnet dynamic route (D1-backed) is mainnet-only too.
    const trends = await get(env, "/api/v1/testnet/subnets/7/health/trends");
    assert.equal(trends.res.status, 404);
    assert.equal(trends.body.meta.network, "testnet");
  });

  test("raw artifact: mainnet alias serves bare data; testnet 404s", async () => {
    const env = createLocalArtifactEnv();
    const mainnet = await get(env, "/metagraph/mainnet/subnets.json");
    assert.equal(mainnet.res.status, 200);
    assert.ok(Array.isArray(mainnet.body.subnets));

    const testnet = await get(env, "/metagraph/testnet/subnets.json");
    assert.equal(testnet.res.status, 404);
  });

  test("a real route segment that merely looks adjacent is never shadowed by the alias set", async () => {
    const env = createLocalArtifactEnv();
    // "subnets"/"providers"/"surfaces" are real routes, not network aliases.
    for (const route of ["/api/v1/subnets", "/api/v1/providers", "/api/v1/surfaces"]) {
      const { res } = await get(env, route);
      assert.equal(res.status, 200, `${route} should be unaffected`);
    }
  });

  test("HEAD is honored and non-GET methods are rejected under a network prefix", async () => {
    const env = createLocalArtifactEnv();
    const head = await get(env, "/api/v1/mainnet/subnets", { method: "HEAD" });
    assert.equal(head.res.status, 200);
    const post = await get(env, "/api/v1/mainnet/subnets", { method: "POST" });
    assert.equal(post.res.status, 405);
  });
});
