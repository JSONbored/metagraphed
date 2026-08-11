// What a caller gets for OMITTING `limit` is part of the contract (#10060).
//
// 103 of the 128 published `limit` parameters carried no `default` while their
// handler applied one, so `openapi.json` could not answer "how many rows do I
// get if I say nothing" -- and the MCP tool mirroring the same route DID
// declare one, leaving the two published surfaces disagreeing about a route
// neither was wrong about. Measured before this landed:
//
//   GET /api/v1/chain/serving              serves 20, published no default
//   get_chain_serving (MCP)                declared 20
//   GET /api/v1/chain/subnet-lifecycle     serves 50, published no default
//   get_chain_subnet_lifecycle (MCP)       declared 100  <- and served it
//
// The number now lives once, next to the ceiling, in the module that owns the
// route's bounds. `limitSchema(max, fallback)` publishes it and `pageLimit()`
// reads it back, so a handler no longer holds a second copy.
//
// ── What this pins ─────────────────────────────────────────────────────────
//
// Three things, each of which failed differently before:
//
//   1. COVERAGE -- every published `limit` says what omitting it does. A route
//      with no default is not silence: it returns the whole collection, and
//      the description says so.
//   2. THE READ -- `pageLimit()` resolves the same number on every route that
//      publishes one, INCLUDING the /{network}/ twins, whose pathname the
//      schema resolver has to map back to the contract path. A resolution miss
//      there is a 500 on a live route, not a lint.
//   3. NO SECOND COPY -- no handler restates a page size. This is the
//      regression that already happened: CHAIN_CALLS_LIMIT_DEFAULT existed and
//      handleChainCalls wrote `limit = 50` anyway.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import { pageLimit } from "../src/route-query.ts";

interface Parameter {
  name: string;
  description?: string;
  schema?: { default?: unknown; maximum?: number };
}
const SPEC = JSON.parse(
  readFileSync("public/metagraph/openapi.json", "utf8"),
) as { paths: Record<string, Record<string, { parameters?: Parameter[] }>> };

/**
 * The routes that answer with the WHOLE collection when `limit` is absent, so
 * a published `default` would be a number the server never applies.
 *
 * Declared rather than derived, because "returns everything" is a property of
 * the handler and not of the schema -- but declared as a list that can only
 * shrink: an entry whose route starts publishing a default fails below, so
 * this cannot quietly become the place a missing default hides.
 *
 * 36 of the 38 are the collection routes, where `paginateRows` pages only once
 * the caller has opted in (#9730) -- correct for REST, which is why the MCP
 * side carries `MCP_LIST_LIMIT_DEFAULT` instead. Verified against production
 * 2026-08-09: all 38 returned the full set, `next_cursor: null`, `rows ===
 * total`.
 */
const FULL_COLLECTION = new Set([
  "/api/v1/{network}/economics",
  "/api/v1/{network}/subnets",
  // #9981: four routes that served a whole baked document until they declared
  // a query collection. They are here rather than carrying a default because
  // the change was deliberately ADDITIVE -- absent still means every matching
  // row, so no existing caller's response moved. Choosing a default for them
  // is a separate decision, per route, the same split #10027 used for
  // /health/trends: capability first, default second.
  "/api/v1/agent-catalog",
  "/api/v1/contracts",
  "/api/v1/fixtures",
  "/api/v1/subnets/{netuid}/trajectory",
  "/api/v1/candidates",
  // Not a collection route: a CEILING with no default by an explicit decision
  // (see EMISSION_PIPELINE_LIMIT_MAX) -- one row per subnet, and the REST route
  // has always served all of them.
  "/api/v1/chain/emission-pipeline",
  "/api/v1/coverage-depth",
  "/api/v1/curation",
  "/api/v1/economics",
  "/api/v1/endpoint-incidents",
  "/api/v1/endpoint-pools",
  "/api/v1/endpoints",
  "/api/v1/evidence",
  "/api/v1/gaps",
  "/api/v1/health",
  "/api/v1/health/history/{date}",
  // Not a collection route either: handleBulkHealthTrends passes `limit ?? null`
  // to the loader, and null means every subnet. Verified live -- no `limit`
  // answers 123 subnets with subnet_count 123, `?limit=3` answers 3 of 123.
  "/api/v1/health/trends",
  "/api/v1/incidents",
  "/api/v1/profiles",
  "/api/v1/providers",
  "/api/v1/providers/{slug}/endpoints",
  "/api/v1/review/adapter-candidates",
  "/api/v1/review/enrichment-evidence",
  "/api/v1/review/enrichment-queue",
  "/api/v1/review/enrichment-targets",
  "/api/v1/review/gaps",
  "/api/v1/review/profile-completeness",
  "/api/v1/rpc/endpoints",
  "/api/v1/rpc/pools",
  "/api/v1/search",
  "/api/v1/search-index",
  "/api/v1/source-snapshots",
  "/api/v1/subnets",
  "/api/v1/subnets/{netuid}/candidates",
  "/api/v1/subnets/{netuid}/endpoints",
  "/api/v1/subnets/{netuid}/evidence",
  "/api/v1/subnets/{netuid}/gaps",
  "/api/v1/subnets/{netuid}/health",
  "/api/v1/subnets/{netuid}/surfaces",
  "/api/v1/surfaces",
]);

/** Enough of a path to make a URL the schema resolver can classify. */
const SUBSTITUTIONS: Record<string, string> = {
  "{netuid}": "64",
  "{network}": "finney",
  "{ss58}": "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F",
  "{hotkey}": "5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u",
  "{ref}": "6500000",
  "{slug}": "opentensor",
  "{date}": "2026-08-01",
};

function concrete(path: string): string {
  let out = path;
  for (const [token, value] of Object.entries(SUBSTITUTIONS)) {
    out = out.split(token).join(value);
  }
  return out;
}

function publishedLimits(): { path: string; parameter: Parameter }[] {
  const found: { path: string; parameter: Parameter }[] = [];
  for (const [path, operations] of Object.entries(SPEC.paths)) {
    const get = operations.get;
    if (!get) continue;
    const parameter = (get.parameters ?? []).find((p) => p.name === "limit");
    if (parameter) found.push({ path, parameter });
  }
  return found;
}

describe("every published limit says what omitting it does (#10060)", () => {
  test("a route either publishes a default or is declared full-collection", () => {
    const silent = publishedLimits()
      .filter(({ path, parameter }) => {
        return (
          typeof parameter.schema?.default !== "number" &&
          !FULL_COLLECTION.has(path)
        );
      })
      .map(({ path }) => path);
    assert.deepEqual(
      silent,
      [],
      "these routes publish a `limit` without saying what a caller gets for " +
        "omitting it. Pass the handler's default to limitSchema(max, fallback), " +
        "or -- if the route really returns every matching row -- add it to " +
        `FULL_COLLECTION with the evidence: ${silent.join(", ")}`,
    );
  });

  test("the full-collection list can only shrink", () => {
    const published = new Map(
      publishedLimits().map(({ path, parameter }) => [
        path,
        parameter.schema?.default,
      ]),
    );
    const stale = [...FULL_COLLECTION].filter(
      (path) => !published.has(path) || typeof published.get(path) === "number",
    );
    assert.deepEqual(
      stale,
      [],
      "these are listed as returning the whole collection but no longer " +
        "publish a bare `limit` -- either the route gained a default (drop " +
        "the entry) or it stopped publishing `limit` at all: " +
        stale.join(", "),
    );
  });

  test("a full-collection route SAYS so in its published description", () => {
    // The point of the list is that a missing default is a statement, not an
    // omission. If the sentence a caller reads does not carry it, the list is
    // only reassuring us.
    const unstated = publishedLimits()
      .filter(({ path }) => FULL_COLLECTION.has(path))
      .filter(
        ({ parameter }) =>
          !(parameter.description ?? "").includes(
            "every matching row is returned",
          ),
      )
      .map(({ path }) => path);
    assert.deepEqual(unstated, [], `undocumented full-collection: ${unstated}`);
  });

  test("a route with a default SAYS which one", () => {
    const unstated = publishedLimits()
      .filter(({ parameter }) => typeof parameter.schema?.default === "number")
      .filter(
        ({ parameter }) =>
          !(parameter.description ?? "").includes(
            `${parameter.schema?.default}`,
          ),
      )
      .map(({ path }) => path);
    assert.deepEqual(unstated, [], `default not in the prose: ${unstated}`);
  });
});

describe("the runtime reads the page size off the contract (#10060)", () => {
  test("pageLimit resolves every published default, twins included", () => {
    const wrong: string[] = [];
    for (const { path, parameter } of publishedLimits()) {
      const declared = parameter.schema?.default;
      if (typeof declared !== "number") continue;
      const url = new URL(`https://api.metagraph.sh${concrete(path)}`);
      let resolved: number | string;
      try {
        resolved = pageLimit(url);
      } catch (error) {
        resolved = `threw: ${(error as Error).message}`;
      }
      if (resolved !== declared) {
        wrong.push(`${path}: published ${declared}, pageLimit ${resolved}`);
      }
    }
    assert.deepEqual(
      wrong,
      [],
      "pageLimit() could not read back what the route publishes -- on a live " +
        `request that is a wrong page size or a 500: ${wrong.join("; ")}`,
    );
  });

  test("an explicit limit still wins over the published default", () => {
    const url = new URL(
      "https://api.metagraph.sh/api/v1/chain/serving?limit=7",
    );
    assert.equal(pageLimit(url), 7);
  });

  test("pageLimit refuses a route that publishes no default", () => {
    // Not a fallback: substituting a number on a route that returns everything
    // would truncate it, which is the failure this whole issue is about.
    const url = new URL("https://api.metagraph.sh/api/v1/subnets");
    assert.throws(() => pageLimit(url), /No published limit default/);
  });

  test("pageLimit refuses a route that declares no limit at all", () => {
    // A different absence from the one above -- there is no field to unwrap,
    // not a field with no default -- and it must not resolve to a number
    // either. /api/v1/coverage publishes no query parameters.
    const url = new URL("https://api.metagraph.sh/api/v1/coverage");
    assert.throws(() => pageLimit(url), /No published limit default/);
  });
});

describe("no handler keeps a second copy of a page size (#10060)", () => {
  const SOURCES = [
    "workers/request-handlers/analytics.ts",
    "workers/request-handlers/analytics-routes.ts",
    "workers/request-handlers/entities.ts",
    "workers/api.ts",
    "workers/data-api.ts",
  ];

  test("no routeQuery destructure supplies its own limit fallback", () => {
    const offenders: string[] = [];
    for (const file of SOURCES) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(
        /const \{[^}]*\blimit\s*=\s*[^,}]+[^}]*\}\s*=\s*(?:routeQuery\(url\)|parsed\.query)/g,
      )) {
        offenders.push(`${file}: ${match[0].split("\n")[0]}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "the page size is published now -- read it with pageLimit(url) rather " +
        `than restating it here: ${offenders.join("; ")}`,
    );
  });

  test("resolvePage takes no pagination profile", () => {
    const offenders: string[] = [];
    for (const file of SOURCES) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/resolvePage\(url,/g)) {
        offenders.push(`${file}: ${match[0]}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "resolvePage reads the route's published default; passing a profile is " +
        `the second copy this removed: ${offenders.join("; ")}`,
    );
  });
});
