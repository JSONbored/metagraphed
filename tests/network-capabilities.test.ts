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

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildNetworkCapabilities,
  buildNetworksPayload,
  routeFamily,
} from "../src/network-capabilities.ts";
import { API_ROUTES } from "../src/contracts.ts";
import { handleRequest, isMainnetOnlyApiPath } from "../workers/api.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";

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

function concretePath(template: string): string {
  const ss58 = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
  return template
    .replace("{netuid}", "1")
    .replace("{ss58}", ss58)
    .replace("{hotkey}", ss58)
    .replace("{h160}", "0x0000000000000000000000000000000000000000")
    .replace("{ref}", "1-0")
    .replace(/\{[^}]+\}/g, "x");
}

function matrix() {
  return buildNetworksPayload({
    routes: API_ROUTES,
    networks: NETWORKS,
    isMainnetOnly: isMainnetOnlyApiPath,
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
  test("changing the predicate changes the output", () => {
    // Property 3, the issue's derivation proof. If this list were
    // hand-maintained, swapping the predicate would change nothing.
    const everythingServed = buildNetworkCapabilities({
      routes: API_ROUTES,
      networks: NETWORKS,
      isMainnetOnly: () => false,
    }).find((network) => network.id === "testnet");
    const nothingServed = buildNetworkCapabilities({
      routes: API_ROUTES,
      networks: NETWORKS,
      isMainnetOnly: () => true,
    }).find((network) => network.id === "testnet");

    assert.equal(everythingServed?.unserved_families.length, 0);
    assert.ok((everythingServed?.served_families.length ?? 0) > 0);
    assert.equal(nothingServed?.served_families.length, 0);
    assert.ok((nothingServed?.unserved_families.length ?? 0) > 0);

    // ...and neither extreme equals the real matrix, so the real one is
    // genuinely reading the predicate.
    const real = testnetEntry();
    assert.notEqual(
      real.served_families.length,
      everythingServed?.served_families.length,
    );
    assert.notEqual(real.served_families.length, 0);
  });

  test("adding a route to the mainnet-only set moves it out of served", () => {
    const pinned = "/api/v1/coverage";
    const before = buildNetworkCapabilities({
      routes: API_ROUTES,
      networks: NETWORKS,
      isMainnetOnly: isMainnetOnlyApiPath,
    }).find((n) => n.id === "testnet");
    const after = buildNetworkCapabilities({
      routes: API_ROUTES,
      networks: NETWORKS,
      isMainnetOnly: (path) =>
        path === pinned || isMainnetOnlyApiPath(concretePath(path)),
    }).find((n) => n.id === "testnet");
    // `coverage` is a single-route family, so pinning it flips the family.
    assert.ok(before?.served_families.some((f) => f.family === "coverage"));
    assert.ok(!after?.served_families.some((f) => f.family === "coverage"));
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
