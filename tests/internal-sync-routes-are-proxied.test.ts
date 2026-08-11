// Both directions between data-api's internal `*-sync` routes and the main
// Worker's proxies for them (#10836).
//
// WHY THIS EXISTS. The producers are metagraphed-infra's poller lanes, and a
// container only knows the PUBLIC host -- it POSTs to `api.metagraph.sh`, not
// to data-api. So a sync route existing on data-api is necessary and NOT
// sufficient: without a proxy branch on the main Worker the POST 404s at the
// edge, and the lane looks like it is running while writing nothing.
//
// That is not hypothetical. `subnet-identity` POSTed to a URL nothing served
// for its entire life (#10710) -- "it has been POSTing here and getting a 404
// since it shipped" -- and the reads never broke, because a Postgres miss
// degrades to a schema-stable empty feed rather than an error. A store with no
// writer read as a healthy, permanently frozen one, and the visible symptom
// was a subnet serving an eight-week-old name.
//
// The same gap nearly shipped again with `subnet-ownership`: the route, the
// migration, the flag and the tests were all in place and the proxy was not.
// Nothing structural would have caught it, so this is the structure.
//
// PARSED FROM THE DISPATCHERS, never from a hand-kept list. A list would go
// stale into a blanket exemption -- which is what the absence of this test
// already was.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";

/** The `/api/v1/internal/*-sync` paths a Worker dispatches on. */
function syncRoutes(file: string): Set<string> {
  const source = readFileSync(file, "utf8");
  return new Set(
    [
      ...source.matchAll(
        /url\.pathname === "(\/api\/v1\/internal\/[a-z0-9-]+-sync)"/g,
      ),
    ].map((m) => m[1]!),
  );
}

/**
 * The subset of the main Worker's sync paths that forward to DATA-API.
 *
 * NOT every internal `*-sync` path on api.ts does, and the two exceptions are
 * both legitimate rather than oversights:
 *
 *   - `/api/v1/internal/emission-gate-sync` is HANDLED on the main Worker
 *   - `/api/v1/internal/registry-sync` proxies to registry-sync-api, a
 *     different Worker entirely
 *
 * So the reverse direction below has to ask "does this forward to data-api?"
 * rather than "is this an internal sync path?". Read off each handler's own
 * body -- a handler that stops calling `proxyToDataApi` stops being checked
 * against data-api, which is the correct behaviour and not an exemption
 * anybody has to remember to update.
 */
function dataApiProxiedRoutes(): Set<string> {
  const source = readFileSync("workers/api.ts", "utf8");
  const forwards = new Set(
    [...source.matchAll(/async function (\w+)\(([\s\S]{0,400}?)\n\}/g)]
      .filter(([, , body]) => body!.includes("proxyToDataApi("))
      .map(([, name]) => name!),
  );
  return new Set(
    [
      ...source.matchAll(
        /url\.pathname === "(\/api\/v1\/internal\/[a-z0-9-]+-sync)"\)\s*\{\s*return (\w+)\(/g,
      ),
    ]
      .filter(([, , handler]) => forwards.has(handler!))
      .map(([, path]) => path!),
  );
}

describe("every internal sync route is reachable from the public host", () => {
  const served = syncRoutes("workers/data-api.ts");
  const proxied = syncRoutes("workers/api.ts");

  test("the parse finds the routes, so the assertions below are real", () => {
    // A regex that matched nothing would make every assertion here vacuous --
    // the failure mode this whole file exists to prevent, wearing a test's
    // clothes.
    assert.ok(
      served.size >= 10,
      `only ${served.size} sync route(s) parsed out of workers/data-api.ts -- the parse broke`,
    );
    assert.ok(
      proxied.size >= 10,
      `only ${proxied.size} proxy branch(es) parsed out of workers/api.ts -- the parse broke`,
    );
  });

  test("every route data-api serves has a proxy on the main Worker", () => {
    const unreachable = [...served].filter((path) => !proxied.has(path)).sort();
    assert.deepEqual(
      unreachable,
      [],
      "these sync routes exist on data-api but the main Worker does not proxy " +
        "them, so a producer POSTing to api.metagraph.sh gets a 404 and the " +
        `lane writes nothing:\n${unreachable.join("\n")}`,
    );
  });

  test("every data-api proxy points at a route that exists", () => {
    // The other direction. A proxy with no route behind it forwards to a 404
    // instead of returning one, which is strictly harder to diagnose: the
    // producer sees the same status either way, and the main Worker's logs
    // show a request it handled.
    const forwarded = dataApiProxiedRoutes();
    assert.ok(
      forwarded.size >= 10,
      `only ${forwarded.size} data-api proxy(ies) resolved -- the handler scan broke`,
    );
    const dangling = [...forwarded].filter((path) => !served.has(path)).sort();
    assert.deepEqual(
      dangling,
      [],
      "the main Worker proxies these paths but data-api serves no such " +
        `route:\n${dangling.join("\n")}`,
    );
  });
});
