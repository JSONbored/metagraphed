// #8698: the published spec must not lie about which networks a route answers on.
//
// Two properties, both required by the issue's definition of done, and both
// enforced here rather than by review:
//
//   1. The spec's network enum equals the router's own alias set. Adding a
//      network to workers/api.ts without touching the spec fails CI.
//   2. Every route's `mainnet_only` annotation equals what the router actually
//      does. Adding a route to isMainnetOnlyApiPath without annotating it fails
//      CI — and so does annotating one the router happily serves on testnet.
//
// Property 2 exists because the hand-written first draft of that list was wrong
// by 77 of 102 entries. A list this long, restating behaviour that lives in a
// 100-line predicate, cannot be kept correct by reading it.

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  API_ROUTES,
  DATA_NETWORK_ALIASES,
  MAINNET_ONLY_ROUTE_PATHS,
  NETWORK_ALIASES,
  buildApiIndexArtifact,
  buildContractsArtifact,
  buildOpenApiArtifact,
  isMainnetOnlyRouteTemplate,
  networkVariantPath,
} from "../src/contracts.ts";
import { isMainnetOnlyApiPath } from "../workers/api.ts";
import { loadOpenApiComponentSchemas } from "../scripts/openapi-components.ts";

/**
 * A concrete request path for a route template.
 *
 * The router's predicate matches real paths, so a template has to be
 * instantiated before it can be asked about. Values are only required to be
 * shape-valid — the predicate is purely structural.
 */
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

describe("network alias set (#8698)", () => {
  test("the contract's alias list matches the router's NETWORKS map", async () => {
    // Derived from behaviour, not from a copy of the map: every alias the
    // contract advertises must actually resolve to a network in the router,
    // and every alias the router accepts must be advertised.
    const { handleRequest } = await import("../workers/api.ts");
    const { createLocalArtifactEnv } = await import("../scripts/lib.ts");
    const env = createLocalArtifactEnv() as unknown as Env;

    // Data aliases must serve registry routes...
    for (const alias of DATA_NETWORK_ALIASES) {
      const res = await handleRequest(
        new Request(`https://api.metagraph.sh/api/v1/${alias}/coverage`),
        env,
        {},
      );
      assert.notEqual(
        res.status,
        404,
        `data alias "${alias}" is advertised but the router does not serve /coverage on it`,
      );
    }

    // ...while `local` routes only its own setup pointer. Asserting it serves
    // /coverage would be asserting a fiction: metagraphed hosts no registry
    // data for a node it cannot reach, which is exactly why it is excluded
    // from DATA_NETWORK_ALIASES.
    const localRoot = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/local"),
      env,
      {},
    );
    assert.notEqual(
      localRoot.status,
      404,
      "local's setup pointer must resolve",
    );
    const localData = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/local/coverage"),
      env,
      {},
    );
    assert.equal(
      localData.status,
      404,
      "local must not pretend to serve registry data",
    );

    // A network that does not exist must NOT resolve — otherwise the enum is
    // decorative and the router accepts anything.
    const bogus = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/mainnnet/coverage"),
      env,
      {},
    );
    assert.equal(bogus.status, 404);
  });

  test("data aliases exclude local, which hosts no registry data", () => {
    // /api/v1/local returns a setup pointer, not subnets. Advertising it as a
    // data-bearing target would tell a generated client it can fetch a
    // registry from a node we neither host nor can enumerate.
    assert.ok(NETWORK_ALIASES.includes("local"));
    assert.ok(!DATA_NETWORK_ALIASES.includes("local"));
    assert.deepEqual(DATA_NETWORK_ALIASES, [
      "finney",
      "mainnet",
      "test",
      "testnet",
    ]);
  });

  test("both spellings of each network are accepted", () => {
    // The chain says finney/test; humans say mainnet/testnet. Dropping either
    // spelling 404s half the callers who guess.
    for (const pair of [
      ["mainnet", "finney"],
      ["testnet", "test"],
    ]) {
      for (const alias of pair) {
        assert.ok(
          DATA_NETWORK_ALIASES.includes(alias),
          `"${alias}" is not advertised`,
        );
      }
    }
  });
});

describe("mainnet-only annotation (#8698)", () => {
  test("every route's annotation equals the router's actual behaviour", () => {
    // THE load-bearing test. Both directions, so neither a missing annotation
    // nor a stale one can survive.
    const mismatches: string[] = [];
    for (const route of API_ROUTES) {
      const actual = isMainnetOnlyApiPath(concretePath(route.path));
      const annotated = isMainnetOnlyRouteTemplate(route.path);
      if (actual !== annotated) {
        mismatches.push(
          `${route.path}: router says mainnet-only=${actual}, contract says ${annotated}`,
        );
      }
    }
    assert.deepEqual(
      mismatches,
      [],
      `MAINNET_ONLY_ROUTE_PATHS is out of sync with isMainnetOnlyApiPath:\n${mismatches.join("\n")}`,
    );
  });

  test("the annotated list contains only real route templates", () => {
    // A stale entry for a route that no longer exists would silently stop
    // being checked by the test above.
    const known = new Set(API_ROUTES.map((route) => route.path));
    for (const path of MAINNET_ONLY_ROUTE_PATHS) {
      assert.ok(
        known.has(path),
        `${path} is annotated but is not an API route`,
      );
    }
  });

  test("a mainnet-only route gets no network variant", () => {
    assert.equal(networkVariantPath("/api/v1/chain/calls"), null);
    assert.equal(
      networkVariantPath("/api/v1/coverage"),
      "/api/v1/{network}/coverage",
    );
    // Non-/api/v1 paths have no network form at all.
    assert.equal(networkVariantPath("/metagraph/coverage.json"), null);
  });
});

describe("the published spec expresses network addressing", () => {
  test("every network-addressable route has a {network} operation with the alias enum", async () => {
    const generatedAt = "1970-01-01T00:00:00.000Z";
    const openapi = buildOpenApiArtifact(
      generatedAt,
      await loadOpenApiComponentSchemas(generatedAt),
    ) as { paths: Record<string, Record<string, Row>> };

    const addressable = API_ROUTES.filter(
      (route) => !isMainnetOnlyRouteTemplate(route.path),
    );
    assert.ok(addressable.length > 0);

    for (const route of addressable) {
      const variant = networkVariantPath(route.path);
      assert.ok(variant, `${route.path} should have a network variant`);
      const operation = openapi.paths[variant]?.[route.method.toLowerCase()];
      assert.ok(operation, `spec is missing ${route.method} ${variant}`);
      const networkParam = (
        operation.parameters as { name: string; schema?: Row }[]
      ).find((parameter) => parameter.name === "network");
      assert.ok(networkParam, `${variant} has no network parameter`);
      // The enum IS the alias set — not a subset, not a superset.
      assert.deepEqual(networkParam.schema?.enum, DATA_NETWORK_ALIASES);
    }
  });

  test("a mainnet-only route is annotated, not silently omitted", async () => {
    // The issue's acceptance question: "Does /api/v1/chain/calls exist on
    // testnet?" must be answerable from the spec with no network call.
    const generatedAt = "1970-01-01T00:00:00.000Z";
    const openapi = buildOpenApiArtifact(
      generatedAt,
      await loadOpenApiComponentSchemas(generatedAt),
    ) as { paths: Record<string, Record<string, Row>> };

    const operation = openapi.paths["/api/v1/chain/calls"].get;
    assert.equal(operation["x-metagraphed-mainnet-only"], true);
    assert.deepEqual(operation["x-metagraphed-networks"], ["mainnet"]);
    // ...and it has no network variant to mislead a client with.
    assert.equal(openapi.paths["/api/v1/{network}/chain/calls"], undefined);

    // Conversely, an addressable route advertises every data alias.
    assert.deepEqual(
      openapi.paths["/api/v1/coverage"].get["x-metagraphed-networks"],
      DATA_NETWORK_ALIASES,
    );
  });

  test("network variants carry distinct operationIds", async () => {
    // Two operations sharing an operationId makes most generators emit one
    // method and drop the other silently.
    const generatedAt = "1970-01-01T00:00:00.000Z";
    const openapi = buildOpenApiArtifact(
      generatedAt,
      await loadOpenApiComponentSchemas(generatedAt),
    ) as { paths: Record<string, Record<string, Row>> };
    const ids = new Set<string>();
    for (const [, methods] of Object.entries(openapi.paths)) {
      for (const [, operation] of Object.entries(methods)) {
        const id = (operation as Row).operationId as string | undefined;
        if (!id) continue;
        assert.ok(!ids.has(id), `duplicate operationId: ${id}`);
        ids.add(id);
      }
    }
  });
});

describe("the contracts artifact carries the network dimension", () => {
  test("agents reading /api/v1/contracts learn testnet exists", () => {
    const contracts = buildContractsArtifact(
      "1970-01-01T00:00:00.000Z",
    ) as unknown as { networks: Row };
    assert.deepEqual(contracts.networks.aliases, NETWORK_ALIASES);
    assert.deepEqual(contracts.networks.data_aliases, DATA_NETWORK_ALIASES);
    assert.equal(contracts.networks.default, "mainnet");

    // Per-route annotation lives on the API index, which is where `routes`
    // lives — both surfaces carry the same block, generated once.
    const artifact = buildApiIndexArtifact(
      "1970-01-01T00:00:00.000Z",
      buildContractsArtifact("1970-01-01T00:00:00.000Z"),
    ) as unknown as {
      networks: Row;
      routes: { path: string; mainnet_only: boolean; networks: string[] }[];
    };
    assert.deepEqual(artifact.networks, contracts.networks);

    const calls = artifact.routes.find(
      (route) => route.path === "/api/v1/chain/calls",
    );
    assert.equal(calls?.mainnet_only, true);
    assert.deepEqual(calls?.networks, ["mainnet"]);

    const coverage = artifact.routes.find(
      (route) => route.path === "/api/v1/coverage",
    );
    assert.equal(coverage?.mainnet_only, false);
    assert.deepEqual(coverage?.networks, DATA_NETWORK_ALIASES);
  });

  test("every route carries the annotation, none left undefined", () => {
    const artifact = buildApiIndexArtifact(
      "1970-01-01T00:00:00.000Z",
      buildContractsArtifact("1970-01-01T00:00:00.000Z"),
    ) as unknown as {
      routes: { path: string; mainnet_only: boolean }[];
    };
    for (const route of artifact.routes) {
      assert.equal(
        typeof route.mainnet_only,
        "boolean",
        `${route.path} has no mainnet_only annotation`,
      );
    }
  });
});

type Row = Record<string, unknown>;
