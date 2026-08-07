// A query parameter that means the same thing everywhere is described once.
//
// The gap this closes (#9131): 942 of the 1,327 query parameters we publish
// carried no `description` at all -- and not the obscure tail. `limit` (134
// operations), `cursor` (77), `fields` (68) and `offset` had none, while
// `format` and `network` had one on every single operation. The cause was
// mechanical rather than editorial: `format`'s descriptions are hand-written
// inline, one per route, so the parameters nobody wanted to type 134 times went
// undocumented.
//
// `cursor` was the sharp one. It is an opaque keyset token
// ("1781631468000.8421037.14") published as a bare string, with nothing telling
// a consumer to echo it back verbatim rather than increment it. This spec is
// the input to a 206-tool MCP server, so an undescribed `cursor` is a model
// deciding, with no information, whether to do arithmetic on a token it must
// copy.
//
// ── What is asserted, and what deliberately is not ──────────────────────────
//
// The guard covers exactly the parameters whose MEANING is uniform across
// routes. `kind`, `status`, `provider` and `id` carry four different
// vocabularies between them, so a shared sentence would be wrong on most of
// them -- those stay inline and are not asserted here. Being narrow is the
// point: a check that demanded a description for every parameter would be
// satisfied by 500 vague ones.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import { SHARED_QUERY_PARAMETER_DESCRIPTIONS } from "../src/contracts.ts";

const SHARED = ["limit", "offset", "cursor", "fields", "window", "netuid", "q"];

interface Parameter {
  name?: string;
  in?: string;
  description?: string;
  schema?: { maximum?: number; enum?: unknown[] };
}

function queryParameters(): { path: string; parameter: Parameter }[] {
  // The PUBLISHED artifact, not a rebuild: this is the document consumers and
  // the MCP server actually read, and validate:contract-drift already fails CI
  // if it has drifted from src/contracts.ts. Asserting on it means a gap can
  // never be green here and present in what we ship.
  const spec = JSON.parse(
    readFileSync("public/metagraph/openapi.json", "utf8"),
  ) as {
    paths: Record<string, Record<string, { parameters?: Parameter[] }>>;
  };
  const found: { path: string; parameter: Parameter }[] = [];
  for (const [path, operations] of Object.entries(spec.paths)) {
    for (const operation of Object.values(operations)) {
      for (const parameter of operation?.parameters ?? []) {
        if (parameter?.in === "query") found.push({ path, parameter });
      }
    }
  }
  return found;
}

/** Paths in the same published spec, for the floors below. */
function specPathCount(): number {
  const spec = JSON.parse(
    readFileSync("public/metagraph/openapi.json", "utf8"),
  ) as { paths: Record<string, unknown> };
  return Object.keys(spec.paths).length;
}

const PARAMETERS = queryParameters();
const SPEC_PATHS = specPathCount();

describe("shared query parameters are described in the published spec (#9131)", () => {
  test("the scan finds the spec's query parameters", () => {
    // A traversal that silently found nothing would make every assertion below
    // vacuously true -- the way a spec-scanning check stops checking.
    // RELATIVE to the spec's own size, not a pinned inventory. The guard is
    // against a traversal that returns nothing; an absolute floor also fails
    // whenever the spec legitimately shrinks, which says nothing about whether
    // the scan works. #9754 removed 65 network variants and took this from 954
    // to 889 -- a correct change, reported as a broken scan.
    assert.ok(
      PARAMETERS.length > SPEC_PATHS,
      `expected the full query-parameter set, found ${PARAMETERS.length} ` +
        `across ${SPEC_PATHS} paths`,
    );
  });

  test("no occurrence of a shared parameter is left undescribed", () => {
    const undescribed = PARAMETERS.filter(
      ({ parameter }) =>
        SHARED.includes(parameter.name ?? "") && !parameter.description,
    ).map(({ path, parameter }) => `${path} ?${parameter.name}`);
    assert.deepEqual(
      undescribed,
      [],
      "these publish a parameter with no explanation of what it does: " +
        `${undescribed.slice(0, 8).join(", ")}${undescribed.length > 8 ? ` (+${undescribed.length - 8})` : ""}. ` +
        "Add it to SHARED_QUERY_PARAMETER_DESCRIPTIONS in src/contracts.ts, " +
        "not inline on the route.",
    );
  });

  test("cursor is documented as opaque, since that is the failure mode", () => {
    // Named rather than left to the generic check. Every other parameter here
    // fails safe when misunderstood -- a wrong `limit` returns the wrong page
    // size and you can see it. A `cursor` treated as a row number produces a
    // paging loop that silently skips or repeats rows.
    const cursors = PARAMETERS.filter(
      ({ parameter }) => parameter.name === "cursor",
    );
    // Same reasoning as the floor above: enough cursors that the per-cursor
    // loop below is not vacuous, expressed against the spec's own size.
    assert.ok(
      cursors.length > SPEC_PATHS / 10,
      `expected the cursor parameters, found ${cursors.length} ` +
        `across ${SPEC_PATHS} paths`,
    );
    for (const { path, parameter } of cursors) {
      assert.match(
        parameter.description ?? "",
        /verbatim/i,
        `${path}'s cursor description must say to echo it back verbatim`,
      );
    }
  });

  test("a per-route value is read from the schema, not restated", () => {
    // `limit`'s ceiling and `window`'s allowed values differ per route, so the
    // shared text interpolates them. If it stated one number instead, every
    // route with a different one would publish a lie -- which is exactly the
    // drift #9127 fixed.
    const limits = PARAMETERS.filter(
      ({ parameter }) =>
        parameter.name === "limit" &&
        typeof parameter.schema?.maximum === "number",
    );
    assert.ok(
      limits.length > 50,
      `expected limits with a maximum, found ${limits.length}`,
    );
    for (const { path, parameter } of limits) {
      // Every limit that HAS a ceiling must state it -- whether the text came
      // from the shared default ("at most 100") or from a route's own inline
      // wording ("Maximum items to return (1-50)"). Publishing a bound the
      // description never mentions is the gap, not which sentence says it.
      assert.ok(
        (parameter.description ?? "").includes(
          String(parameter.schema?.maximum),
        ),
        `${path}'s limit description never mentions its own maximum (${parameter.schema?.maximum})`,
      );
    }
    const windows = PARAMETERS.filter(
      ({ parameter }) =>
        parameter.name === "window" && Array.isArray(parameter.schema?.enum),
    );
    assert.ok(
      windows.length > 20,
      `expected windows with an enum, found ${windows.length}`,
    );
    for (const { path, parameter } of windows) {
      for (const value of parameter.schema?.enum ?? []) {
        assert.ok(
          (parameter.description ?? "").includes(`\`${String(value)}\``),
          `${path}'s window description omits its own allowed value ${String(value)}`,
        );
      }
    }
  });

  test("an inline description still wins", () => {
    // The shared map is a fallback, not an override. The feed routes are the
    // proof: their `limit` IS in the shared map and they carry their own
    // wording, so if the fallback ever started overwriting instead of filling
    // gaps, this text would vanish.
    const inline = PARAMETERS.filter(
      ({ parameter }) =>
        parameter.name === "limit" &&
        (parameter.description ?? "").startsWith("Maximum items to return"),
    );
    assert.ok(
      inline.length >= 20,
      "the feed routes' own limit wording was overwritten by the shared " +
        `default -- ${inline.length} of them still carry it`,
    );
    // And the shared default is genuinely reaching the routes that have no
    // inline text, rather than the map being wired up but never applied.
    const shared = PARAMETERS.filter(
      ({ parameter }) =>
        parameter.name === "limit" &&
        (parameter.description ?? "").includes("Read the `limit` echoed"),
    );
    assert.ok(
      shared.length > 50,
      `the shared limit default reached only ${shared.length} operations`,
    );
  });

  test("a schema-driven description degrades cleanly when the value is absent", () => {
    // Every `window` in the spec today carries an enum and every bounded
    // `limit` a maximum, so these fallbacks never run against real routes.
    // They still have to produce a readable sentence rather than a dangling
    // "Accepts ." or "at most undefined" the day a route declares one without.
    const windowText = SHARED_QUERY_PARAMETER_DESCRIPTIONS.window({});
    assert.doesNotMatch(
      windowText,
      /Accepts\s*\./,
      "an enum-less window must omit the list, not print an empty one",
    );
    assert.match(windowText, /Trailing lookback window/);

    const limitText = SHARED_QUERY_PARAMETER_DESCRIPTIONS.limit({});
    assert.doesNotMatch(
      limitText,
      /at most/,
      "a limit with no declared maximum must not claim one",
    );
    assert.match(limitText, /Maximum number of rows/);
  });
});
