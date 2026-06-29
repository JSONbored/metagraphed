import path from "node:path";
import assert from "node:assert/strict";
import { beforeAll, describe, test } from "vitest";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv, repoRoot } from "../scripts/lib.mjs";
import { buildNetworkRegistry } from "../scripts/build-network-registry.mjs";

const ORIGIN = "https://api.metagraph.sh";
const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

// Build the testnet registry from the committed snapshot so the data-present
// assertions don't depend on a prior `npm run build`. `local` is intentionally
// never built — it stays the no-data network for the 404 cases.
beforeAll(async () => {
  await buildNetworkRegistry({
    prefix: "testnet",
    snapshotPath: path.join(repoRoot, "registry/native/test-subnets.json"),
  });
});

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
    assert.equal(
      aliased.body.data?.subnet?.netuid,
      bare.body.data?.subnet?.netuid,
    );
  });

  test("repeated default aliases are canonicalized without recursive dispatch", async () => {
    const env = createLocalArtifactEnv();
    const aliases = Array.from({ length: 12000 }, (_, index) =>
      index % 2 === 0 ? "mainnet" : "finney",
    ).join("/");
    const bare = await get(env, "/api/v1/subnets");
    const aliased = await get(env, `/api/v1/${aliases}/subnets`);

    assert.equal(aliased.res.status, bare.res.status);
    assert.equal(
      aliased.body.data?.subnets?.length,
      bare.body.data?.subnets?.length,
    );
  });

  test("mainnet + finney aliases preserve dynamic mainnet routes", async () => {
    const env = createLocalArtifactEnv();

    for (const route of [
      "/api/v1/registry/leaderboards",
      "/api/v1/health/trends",
      "/api/v1/subnets/7/health/trends",
    ]) {
      const bare = await get(env, route);
      const mainnet = await get(
        env,
        route.replace("/api/v1/", "/api/v1/mainnet/"),
      );
      const finney = await get(
        env,
        route.replace("/api/v1/", "/api/v1/finney/"),
      );

      assert.equal(
        mainnet.res.status,
        bare.res.status,
        `mainnet alias for ${route}`,
      );
      assert.equal(
        finney.res.status,
        bare.res.status,
        `finney alias for ${route}`,
      );
    }

    const askInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "What is subnet 7?" }),
    };
    const bareAsk = await get(env, "/api/v1/ask", askInit);
    const mainnetAsk = await get(env, "/api/v1/mainnet/ask", askInit);
    const finneyAsk = await get(env, "/api/v1/finney/ask", askInit);

    assert.notEqual(bareAsk.res.status, 405);
    assert.equal(mainnetAsk.res.status, bareAsk.res.status);
    assert.equal(finneyAsk.res.status, bareAsk.res.status);
  });

  test("testnet route serves network-partitioned data from the testnet key", async () => {
    const env = createLocalArtifactEnv();
    const { res, body } = await get(env, "/api/v1/testnet/subnets");
    assert.equal(res.status, 200);
    assert.ok(body.data.subnets.length > 50);
    assert.equal(body.data.network, "test");
    assert.equal(body.meta.artifact_path, "/metagraph/testnet/subnets.json");

    // The contact fields (issue #344) must be projected on the testnet index
    // too, not just mainnet (regression: testnet buildIndexEntry was missed).
    for (const entry of body.data.subnets) {
      assert.equal(
        typeof entry.contact_present,
        "boolean",
        `testnet ${entry.netuid}: contact_present must be a boolean`,
      );
      assert.ok(
        "discord" in entry && "discord_url" in entry,
        `testnet ${entry.netuid}: discord fields must be projected`,
      );
    }

    // Testnet netuids are independent of mainnet — a testnet subnet exists that
    // mainnet doesn't enumerate, proving cross-network isolation.
    const detail = await get(env, "/api/v1/testnet/subnets/11");
    assert.equal(detail.res.status, 200);
    assert.equal(detail.body.data.subnet.netuid, 11);
  });

  test("pagination Link header keeps the /testnet/ prefix (#1686)", async () => {
    const env = createLocalArtifactEnv();
    // The /{network}/ segment is stripped before dispatch, so the Link header
    // must re-insert it — otherwise a client walking testnet via the next link
    // would silently cross over to the mainnet collection.
    const { res } = await get(
      env,
      "/api/v1/testnet/subnets?sort=netuid&limit=1&cursor=0",
    );
    assert.equal(res.status, 200);
    const link = res.headers.get("link");
    assert.ok(link, "a paginated testnet response must carry a Link header");
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    assert.ok(next, "the Link header must advertise rel=next");
    assert.equal(new URL(next[1]).pathname, "/api/v1/testnet/subnets");
  });

  test("testnet subnet details do not receive mainnet live economics", async () => {
    const economicsBlob = {
      schema_version: 1,
      captured_at: new Date().toISOString(),
      summary: { with_economics_count: 1 },
      subnets: [
        {
          netuid: 1,
          name: "MAINNET economics row for netuid 1",
          emission_share: 1,
          validators: 123,
          miners: 456,
        },
      ],
    };
    const env = createLocalArtifactEnv({
      METAGRAPH_CONTROL: {
        async get(key) {
          return key === "economics:current" ? economicsBlob : null;
        },
      },
    });

    const detail = await get(env, "/api/v1/testnet/subnets/1");

    assert.equal(detail.res.status, 200);
    assert.equal(
      detail.body.meta.artifact_path,
      "/metagraph/testnet/subnets/1.json",
    );
    assert.equal(detail.body.data.subnet.netuid, 1);
    assert.equal(detail.body.data.economics, undefined);
  });

  test("local network route 404s cleanly (no data published)", async () => {
    const env = createLocalArtifactEnv();
    const { res } = await get(env, "/api/v1/local/coverage");
    assert.equal(res.status, 404);
  });

  test("subnets resolve by chain name (native_slug) on mainnet + testnet (regression: #331)", async () => {
    const env = createLocalArtifactEnv();
    // "apex" is the on-chain name of netuid 1 (curated slug is sn-1) — the name
    // agents discover it by. Must resolve on both networks, including testnet
    // where there are no curated overlay slugs at all.
    const mainnet = await get(env, "/api/v1/subnets/apex");
    assert.equal(mainnet.res.status, 200);
    assert.equal(mainnet.body.data.subnet.netuid, 1);

    const testnet = await get(env, "/api/v1/testnet/subnets/apex");
    assert.equal(testnet.res.status, 200);
    assert.equal(testnet.body.data.subnet.netuid, 1);

    // The curated/sn-N slug and numeric forms still resolve.
    assert.equal((await get(env, "/api/v1/subnets/sn-1")).res.status, 200);
    assert.equal((await get(env, "/api/v1/subnets/7")).res.status, 200);
  });

  test("duplicate native_slug aliases are not routed by first artifact order", async () => {
    const env = createLocalArtifactEnv();
    // Several committed mainnet entries have native_slug="deprecated"; resolving
    // that alias would be ambiguous and artifact-order dependent, so it must stay
    // unavailable while canonical numeric routes continue to work.
    const ambiguous = await get(env, "/api/v1/subnets/deprecated");
    assert.equal(ambiguous.res.status, 404);

    for (const netuid of [3, 39, 81]) {
      const numeric = await get(env, `/api/v1/subnets/${netuid}/health/trends`);
      assert.equal(numeric.res.status, 200);
      assert.equal(numeric.body.data.netuid, netuid);
    }
  });

  test("local network exposes a client-side dev-mode setup pointer", async () => {
    const env = createLocalArtifactEnv();
    const info = await get(env, "/api/v1/local");
    assert.equal(info.res.status, 200);
    assert.equal(info.body.data.network, "local");
    assert.equal(info.body.data.mode, "client-side");
    assert.equal(info.body.data.rpc.ws, undefined);
    assert.equal(info.body.data.rpc.network_arg, "local");
    // Develop-before-mainnet quickstart (issue #354): real ordered steps + the
    // testnet/mainnet/lineage references, not just a ws:// URL.
    const steps = info.body.data.quickstart?.steps;
    assert.ok(Array.isArray(steps) && steps.length >= 4);
    assert.deepEqual(
      steps.map((s) => s.step),
      steps.map((_, i) => i + 1),
    );
    assert.ok(steps.every((s) => s.title && s.run && s.detail));
    assert.ok(steps.some((s) => /localnet\.sh/.test(s.run)));
    assert.ok(steps.some((s) => /btcli subnet create/.test(s.run)));
    assert.equal(info.body.data.reference.lineage, "/api/v1/lineage");
    assert.equal(
      info.body.data.reference.testnet_subnets,
      "/api/v1/testnet/subnets",
    );
    // Data routes under local stay 404 — nothing is hosted for a local chain.
    const data = await get(env, "/api/v1/local/subnets");
    assert.equal(data.res.status, 404);
  });

  test("mainnet-only dynamic routes 404 under a non-default network prefix, naming the network", async () => {
    const env = createLocalArtifactEnv();
    const semantic = await get(env, "/api/v1/testnet/search/semantic");
    assert.equal(semantic.res.status, 404);
    assert.equal(semantic.body.meta.network, "testnet");

    const leaderboards = await get(
      env,
      "/api/v1/testnet/registry/leaderboards",
    );
    assert.equal(leaderboards.res.status, 404);

    // D1-backed health trend routes are mainnet-only too.
    const bulkTrends = await get(env, "/api/v1/testnet/health/trends");
    assert.equal(bulkTrends.res.status, 404);
    assert.equal(bulkTrends.body.meta.network, "testnet");

    const trends = await get(env, "/api/v1/testnet/subnets/7/health/trends");
    assert.equal(trends.res.status, 404);
    assert.equal(trends.body.meta.network, "testnet");

    // Cross-subnet compare composes the mainnet registry + economics + health,
    // so it is mainnet-only too.
    const compare = await get(env, "/api/v1/testnet/compare?netuids=1");
    assert.equal(compare.res.status, 404);
    assert.equal(compare.body.meta.network, "testnet");

    const providerReport = await get(
      env,
      "/api/v1/testnet/providers/datura/report",
    );
    assert.equal(providerReport.res.status, 404);
    assert.equal(providerReport.body.meta.network, "testnet");
  });

  test("D1-backed live routes 404 under testnet with a mainnet-only message", async () => {
    const env = createLocalArtifactEnv();
    for (const path of [
      "/api/v1/testnet/blocks",
      "/api/v1/testnet/blocks/12345",
      "/api/v1/testnet/extrinsics",
      `/api/v1/testnet/accounts/${SS58}`,
      "/api/v1/testnet/subnets/7/metagraph",
      "/api/v1/testnet/subnets/7/validators",
      "/api/v1/testnet/subnets/7/events",
      "/api/v1/testnet/subnets/7/health",
      "/api/v1/testnet/incidents",

      "/api/v1/testnet/rpc/usage",
      "/api/v1/testnet/chain/activity",
    ]) {
      const { res, body } = await get(env, path);
      assert.equal(res.status, 404, path);
      assert.equal(body.meta.network, "testnet", path);
      assert.match(body.error.message, /only available on mainnet/i, path);
    }
    // Partitioned registry routes stay available under testnet.
    const subnets = await get(env, "/api/v1/testnet/subnets");
    assert.equal(subnets.res.status, 200);
  });

  test("mainnet-only routes 404 under testnet for POST as well as GET", async () => {
    const env = createLocalArtifactEnv();
    for (const [method, path] of [
      ["GET", "/api/v1/testnet/graphql"],
      ["POST", "/api/v1/testnet/graphql"],
      ["POST", "/api/v1/testnet/ask"],
      ["GET", "/api/v1/testnet/blocks"],
    ]) {
      const { res, body } = await get(env, path, { method });
      assert.equal(res.status, 404, `${method} ${path}`);
      assert.equal(body.meta.network, "testnet", `${method} ${path}`);
      assert.match(
        body.error.message,
        /only available on mainnet/i,
        `${method} ${path}`,
      );
    }
  });

  test("non-mainnet-only POST under a network prefix still returns 405", async () => {
    const env = createLocalArtifactEnv();
    const { res, body } = await get(env, "/api/v1/testnet/subnets", {
      method: "POST",
    });
    assert.equal(res.status, 405);
    assert.equal(body.error.code, "method_not_allowed");
  });

  test("raw artifact: mainnet alias and testnet both serve their partitioned data", async () => {
    const env = createLocalArtifactEnv();
    const mainnet = await get(env, "/metagraph/mainnet/subnets.json");
    assert.equal(mainnet.res.status, 200);
    assert.ok(Array.isArray(mainnet.body.subnets));

    const testnet = await get(env, "/metagraph/testnet/subnets.json");
    assert.equal(testnet.res.status, 200);
    assert.equal(testnet.body.network, "test");
    // Distinct registries — testnet has its own (larger) subnet set.
    assert.notEqual(testnet.body.subnets.length, mainnet.body.subnets.length);
  });

  test("a real route segment that merely looks adjacent is never shadowed by the alias set", async () => {
    const env = createLocalArtifactEnv();
    // "subnets"/"providers"/"surfaces" are real routes, not network aliases.
    for (const route of [
      "/api/v1/subnets",
      "/api/v1/providers",
      "/api/v1/surfaces",
    ]) {
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
