// #8699: the capability matrix must not lie.
//
// A wrong matrix is worse than none — it makes an agent confidently plan a call
// that 404s — so these tests check the reported matrix against REAL REQUESTS
// through the real router, not against a fixture of what we think it says.
//
// Three properties, all named in the issue's definition of done:
//   1. Every family reported served on testnet actually answers there.
//   2. Every family reported unserved actually 404s there.
//   3. The matrix is derived: change the predicate and the output changes.

import path from "node:path";
import assert from "node:assert/strict";
import { concretePath } from "./concrete-path.ts";
import { describe, test } from "vitest";
import {
  buildNetworkCapabilities,
  buildNetworksPayload,
  routeFamily,
} from "../src/network-capabilities.ts";
import { API_ROUTES } from "../src/contracts.ts";
import { handleRequest, isMainnetOnlyApiPath } from "../workers/api.ts";
import { createLocalArtifactEnv, repoRoot } from "../scripts/lib.ts";
import { buildNetworkRegistry } from "../scripts/build-network-registry.ts";
import {
  NETWORK_COMPUTED_ARTIFACT_PATHS,
  NETWORK_PUBLISHED_ARTIFACT_PATHS,
} from "../src/network-artifacts.ts";
import { LIVE_CHAIN_ROUTE_PATHS } from "../src/live-chain-routes.ts";

const NETWORKS = {
  mainnet: { id: "mainnet", chain: "finney", prefix: "", isDefault: true },
  finney: { id: "mainnet", chain: "finney", prefix: "", isDefault: true },
  testnet: {
    id: "testnet",
    chain: "test",
    prefix: "testnet",
    isDefault: false,
  },
  test: { id: "testnet", chain: "test", prefix: "testnet", isDefault: false },
  local: { id: "local", chain: "local", prefix: "local", isDefault: false },
};

function matrix() {
  return buildNetworksPayload({
    routes: API_ROUTES,
    networks: NETWORKS,
    isMainnetOnly: isMainnetOnlyApiPath,
    publishedArtifacts: NETWORK_PUBLISHED_ARTIFACT_PATHS,
    liveChainRoutes: LIVE_CHAIN_ROUTE_PATHS,
  });
}

function testnetEntry() {
  const entry = matrix().networks.find((network) => network.id === "testnet");
  assert.ok(entry, "no testnet entry in the matrix");
  return entry;
}

describe("routeFamily", () => {
  test("groups by the first segment, keeping sub-resources together", () => {
    // An agent asks "is subnet data available", not "is
    // subnet-concentration-history available".
    assert.equal(routeFamily("/api/v1/subnets"), "subnets");
    assert.equal(
      routeFamily("/api/v1/subnets/{netuid}/concentration/history"),
      "subnets",
    );
    assert.equal(routeFamily("/api/v1/chain/calls"), "chain");
    assert.equal(routeFamily("/api/v1"), "root");
    assert.equal(routeFamily("/metagraph/coverage.json"), null);
  });
});

describe("the matrix matches what the router actually does", () => {
  test("every family reported served on testnet answers there", async () => {
    // Property 1, against real requests. A served family whose routes 404
    // would be the failure mode this whole route exists to prevent.
    const env = createLocalArtifactEnv() as unknown as Env;
    const served = new Set(
      testnetEntry().served_families.map((entry) => entry.family),
    );
    const failures: string[] = [];

    for (const route of API_ROUTES) {
      const family = routeFamily(route.path);
      if (!family || !served.has(family)) continue;
      const res = await handleRequest(
        new Request(
          `https://api.metagraph.sh/api/v1/testnet${concretePath(route.path).slice("/api/v1".length)}`,
        ),
        env,
        {},
      );
      // A cold local artifact store can yield 5xx/empty; only a 404 means
      // "this network does not serve it", which is what is being asserted.
      if (res.status === 404) {
        failures.push(`${route.path} (family "${family}") 404s on testnet`);
      }
    }
    assert.deepEqual(failures, []);
  });

  test("every family reported unserved on testnet does 404 there", async () => {
    // Property 2, the other direction: reporting a family as unavailable when
    // it works would send agents to mainnet unnecessarily.
    const env = createLocalArtifactEnv() as unknown as Env;
    const unserved = new Set(
      testnetEntry().unserved_families.map((entry) => entry.family),
    );
    const failures: string[] = [];

    for (const route of API_ROUTES) {
      const family = routeFamily(route.path);
      if (!family || !unserved.has(family)) continue;
      const res = await handleRequest(
        new Request(
          `https://api.metagraph.sh/api/v1/testnet${concretePath(route.path).slice("/api/v1".length)}`,
        ),
        env,
        {},
      );
      if (res.status !== 404) {
        failures.push(
          `${route.path} (family "${family}") is reported unserved but returned ${res.status}`,
        );
      }
    }
    assert.deepEqual(failures, []);
  });

  test("a partial family is reported as partial, never as served", () => {
    // `subnets` serves most routes off mainnet but not
    // subnets/{netuid}/health. Calling that "served" is the confident-404 case.
    const entry = testnetEntry();
    const partial = new Set(
      entry.partial_families.map((family) => family.family),
    );
    const served = new Set(entry.served_families.map((f) => f.family));
    const unserved = new Set(entry.unserved_families.map((f) => f.family));
    assert.ok(partial.size > 0, "expected at least one partial family");
    for (const family of partial) {
      assert.ok(!served.has(family), `${family} is both partial and served`);
      assert.ok(
        !unserved.has(family),
        `${family} is both partial and unserved`,
      );
    }
  });
});

describe("the matrix is derived, not copied", () => {
  test("availability needs BOTH conditions, and each one moves the output", () => {
    // A route serves off mainnet only when it is not mainnet-only AND its
    // artifact is published for that network. Relaxing either condition
    // changes the matrix, which is what proves neither is a decoration.
    const real = testnetEntry();

    // Relax the predicate alone: still bounded by what the build publishes,
    // so it cannot suddenly claim everything.
    const noPredicate = buildNetworkCapabilities({
      routes: API_ROUTES,
      networks: NETWORKS,
      isMainnetOnly: () => false,
      publishedArtifacts: NETWORK_PUBLISHED_ARTIFACT_PATHS,
    }).find((network) => network.id === "testnet");
    assert.ok(
      (noPredicate?.served_families.length ?? 0) < API_ROUTES.length,
      "dropping the predicate must not make every route serve — publication still gates it",
    );

    // Relax publication alone: the predicate still withholds mainnet-only
    // families, so the two conditions are independent.
    const everythingPublished = buildNetworkCapabilities({
      routes: API_ROUTES,
      networks: NETWORKS,
      isMainnetOnly: isMainnetOnlyApiPath,
      publishedArtifacts: API_ROUTES.map((route) => route.artifact_path),
    }).find((network) => network.id === "testnet");
    assert.ok(
      (everythingPublished?.served_families.length ?? 0) >
        (real.served_families.length ?? 0),
      "publishing everything must widen the served set",
    );
    assert.ok(
      (everythingPublished?.unserved_families.length ?? 0) > 0,
      "mainnet-only families must stay unserved even when everything is published",
    );

    // Publish nothing AND declare no live-chain routes: nothing serves,
    // whatever the predicate says.
    const nothingPublished = buildNetworkCapabilities({
      routes: API_ROUTES,
      networks: NETWORKS,
      isMainnetOnly: () => false,
      publishedArtifacts: [],
    }).find((network) => network.id === "testnet");
    assert.equal(nothingPublished?.served_families.length, 0);

    // The third condition (#8700) is independent of the other two: with no
    // artifacts published at all, the live-chain routes still serve, because
    // they answer from chain state rather than from R2. Without this term the
    // matrix under-reports — it calls a working route unserved, which sends an
    // agent away from a route that would have answered.
    const liveOnly = buildNetworkCapabilities({
      routes: API_ROUTES,
      networks: NETWORKS,
      isMainnetOnly: isMainnetOnlyApiPath,
      publishedArtifacts: [],
      liveChainRoutes: LIVE_CHAIN_ROUTE_PATHS,
    }).find((network) => network.id === "testnet");
    const liveFamilies = [
      ...(liveOnly?.served_families ?? []),
      ...(liveOnly?.partial_families ?? []),
    ].map((entry) => entry.family);
    assert.ok(
      liveFamilies.includes("crowdloans"),
      "the live-chain term must serve crowdloans even with nothing published",
    );
    assert.ok(
      liveFamilies.includes("network"),
      "the live-chain term must serve network/parameters with nothing published",
    );

    // And dropping it alone narrows the matrix — proving it is load-bearing
    // rather than additive decoration.
    const withoutLive = buildNetworkCapabilities({
      routes: API_ROUTES,
      networks: NETWORKS,
      isMainnetOnly: isMainnetOnlyApiPath,
      publishedArtifacts: NETWORK_PUBLISHED_ARTIFACT_PATHS,
    }).find((network) => network.id === "testnet");
    assert.ok(
      (withoutLive?.unserved_families.length ?? 0) >
        (real.unserved_families.length ?? 0),
      "removing the live-chain term must widen the unserved set",
    );
  });

  test("the served set matches what the build actually writes", () => {
    // The verified testnet surface, cross-checked against production on
    // 2026-07-30: subnets, coverage and economics return 200; every other
    // family 404s.
    const entry = testnetEntry();
    const served = new Set(entry.served_families.map((f) => f.family));
    const partial = new Set(entry.partial_families.map((f) => f.family));

    // coverage is a whole family, fully served.
    assert.ok(served.has("coverage"));
    // `networks` is the matrix route itself — computed live, answered before
    // every gate, so it is guaranteed on all networks.
    assert.ok(served.has("networks"));

    // `subnets` and `economics` are PARTIAL, not served. /api/v1/subnets,
    // /api/v1/subnets/{netuid} and /api/v1/economics are published for
    // testnet, but the health/metagraph/history sub-routes and
    // /api/v1/economics/trends are mainnet-only. Reporting either family as
    // simply "served" is the confident-404 this route exists to prevent.
    for (const family of ["subnets", "economics"]) {
      assert.ok(partial.has(family), `${family} must be reported as partial`);
      assert.ok(!served.has(family), `${family} must not be reported served`);
    }

    // Nothing curated leaks in.
    for (const family of ["surfaces", "profiles", "endpoints", "providers"]) {
      assert.ok(!served.has(family), `${family} must not be reported served`);
    }
  });

  test("the published list equals what the emitter actually writes", async () => {
    // #8700. Until now this coupling was asserted only in prose:
    // build-network-registry.ts imported NETWORK_PUBLISHED_ARTIFACT_PATHS and
    // immediately `void`ed it, so the claim that "the emitter and the
    // capability matrix cannot disagree" was enforced by nothing. Adding a
    // fifth artifact family to the build without listing it here would have
    // left the matrix reporting a published route as unserved, and the
    // reverse would have promised a route that 404s.
    const result = await buildNetworkRegistry({
      prefix: "testnet",
      snapshotPath: path.join(repoRoot, "registry/native/test-subnets.json"),
    });
    const written = [...(result.written_artifact_paths as string[])].sort();
    const expected = NETWORK_PUBLISHED_ARTIFACT_PATHS.filter(
      (artifactPath) => !NETWORK_COMPUTED_ARTIFACT_PATHS.includes(artifactPath),
    ).sort();
    assert.deepEqual(
      written,
      expected,
      "buildNetworkRegistry writes a different artifact set than NETWORK_PUBLISHED_ARTIFACT_PATHS declares",
    );
  });
});

describe("GET /api/v1/networks never 404s", () => {
  test("resolves under every network prefix, identically", async () => {
    // The one route that must answer everywhere — it is how a caller learns
    // what does not.
    const env = createLocalArtifactEnv() as unknown as Env;
    const bodies: string[] = [];
    for (const path of [
      "/api/v1/networks",
      "/api/v1/mainnet/networks",
      "/api/v1/finney/networks",
      "/api/v1/testnet/networks",
      "/api/v1/test/networks",
      "/api/v1/local/networks",
    ]) {
      const res = await handleRequest(
        new Request(`https://api.metagraph.sh${path}`),
        env,
        {},
      );
      assert.equal(res.status, 200, `${path} did not return 200`);
      const body = (await res.json()) as { data: unknown };
      bodies.push(JSON.stringify(body.data));
    }
    // Identical on every network: the document describes the whole matrix, so
    // an agent can plan cross-network work from one request.
    assert.equal(new Set(bodies).size, 1, "the payload differs by prefix");
  });

  test("local is reported honestly as hosting no data", async () => {
    const local = matrix().networks.find((network) => network.id === "local");
    assert.equal(local?.serves_data, false);
    assert.deepEqual(local?.served_families, []);
    assert.ok(local?.note?.includes("run yourself"));
  });

  test("mainnet serves everything and reports nothing unserved", () => {
    const mainnet = matrix().networks.find((network) => network.is_default);
    assert.equal(mainnet?.unserved_families.length, 0);
    assert.equal(mainnet?.partial_families.length, 0);
    assert.ok((mainnet?.served_families.length ?? 0) > 0);
  });

  test("aliases collapse onto one entry per network", () => {
    // finney/mainnet are one network reported once, with both spellings —
    // not two entries a caller has to reconcile.
    const payload = matrix();
    assert.equal(payload.network_count, 3);
    const mainnet = payload.networks.find((n) => n.id === "mainnet");
    assert.deepEqual(mainnet?.aliases, ["finney", "mainnet"]);
    const testnet = payload.networks.find((n) => n.id === "testnet");
    assert.deepEqual(testnet?.aliases, ["test", "testnet"]);
  });
});
