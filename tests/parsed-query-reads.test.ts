// Handlers read the PARSED query, not the query string (#10060).
//
// The router parses every GET's parameters against the route's own Zod schema
// before dispatch (#10218), so a handler reaching back into
// `url.searchParams` re-reads a value that has already been decoded, typed and
// bounds-checked -- and, historically, re-stated the bound while doing it:
//
//   url.searchParams.get("window") || DEFAULT_SUBNET_SERVING_WINDOW
//   url.searchParams.get("sort")   || DEFAULT_MOVERS_SORT
//   parseBoundedIntParam(url, "limit", { def, min, max })
//
// Each of those is a copy of something the contract publishes, in the one place
// the contract cannot see. 104 such reads survived #10218; 8 remain, and they
// remain for reasons, which is what this file records. It is a SOURCE check
// because the defect is a shape in the code, not a behaviour: the behaviour is
// identical either way right up until the two copies disagree.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";

/** The request path: the router and the three handler modules it dispatches to. */
const REQUEST_PATH = [
  "workers/api.ts",
  "workers/request-handlers/entities.ts",
  "workers/request-handlers/analytics.ts",
  "workers/request-handlers/analytics-routes.ts",
];

/**
 * The reads that stay, and why.
 *
 * `format` is the one parameter accepted on EVERY route whether the route
 * declares it or not (`GLOBALLY_ACCEPTED_PARAM` in src/contracts.ts, a
 * documented judgement that exists so /chain-events/stats can keep ignoring
 * it). `routeQuery(url).format` is therefore `undefined` on the routes that do
 * not declare it, and the format negotiation has to see the raw value to
 * answer them -- so these reads are the parameter's OWN handling, not a second
 * copy of a bound.
 *
 * The two by-name helpers take the parameter as an argument rather than naming
 * one, so there is no schema to look up: `parseBooleanParam(url, name, def)`
 * and the tri-state `flag(name)` in the validator-economics ranking are
 * generic over a name the caller supplies.
 *
 * A list that can only shrink: a name that stops appearing fails below, so
 * this cannot quietly become the place a new raw read hides.
 */
const DECLARED: Record<string, number> = {
  // `format`, on the routes that negotiate it before the schema is consulted.
  format: 6,
  // The two by-name generic readers, matched by their parameter variable.
  parameter: 1,
  name: 1,
  // The audit seam's projection signal (#11079). auditResponse wraps the
  // default fetch export, OUTSIDE the router's parse, and derives `projected`
  // from the URL alone -- the same way it reads fields/sections via `.has()`,
  // which this regex does not see. Not a second copy of a bound:
  // parseBooleanParam is strict, so the literal "false" is the only value the
  // read can act on, and any other value never reaches the seam as a 200.
  include_points: 1,
};

function rawReads(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(/searchParams\.get\((?:"([a-z_]+)"|(\w+))\)/g)].map(
    (match) => match[1] ?? match[2],
  );
}

describe("the request path reads the parsed query (#10060)", () => {
  test("every raw read left is one this file declares", () => {
    const counts: Record<string, number> = {};
    for (const file of REQUEST_PATH) {
      for (const name of rawReads(file)) {
        counts[name] = (counts[name] ?? 0) + 1;
      }
    }
    const undeclared = Object.keys(counts).filter((name) => !DECLARED[name]);
    assert.deepEqual(
      undeclared,
      [],
      "these parameters are read off the query string in the request path, " +
        "where the router has already parsed them against the route's schema. " +
        "Read them with routeQuery(url) / routeText / routeInt / routeValue, " +
        `or declare the exception with its reason: ${undeclared.join(", ")}`,
    );
  });

  test("the declared set can only shrink", () => {
    const counts: Record<string, number> = {};
    for (const file of REQUEST_PATH) {
      for (const name of rawReads(file)) {
        counts[name] = (counts[name] ?? 0) + 1;
      }
    }
    const grew = Object.entries(DECLARED)
      .filter(([name, allowed]) => (counts[name] ?? 0) > allowed)
      .map(([name, allowed]) => `${name}: ${counts[name]} > ${allowed}`);
    assert.deepEqual(grew, [], `raw reads increased: ${grew.join(", ")}`);

    const gone = Object.entries(DECLARED)
      .filter(([name]) => counts[name] === undefined)
      .map(([name]) => name);
    assert.deepEqual(
      gone,
      [],
      `declared but no longer read -- delete the entry: ${gone.join(", ")}`,
    );
  });

  test("no handler restates a page size or a window default", () => {
    // The specific shape the conversion removed, kept out by name: a fallback
    // written beside a read of a parameter the route publishes a default for.
    const offenders: string[] = [];
    for (const file of REQUEST_PATH) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(
        /searchParams\.get\("(?:limit|offset|window|sort|order|direction|interval|days|basis)"\)/g,
      )) {
        offenders.push(`${file}: ${match[0]}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "these parameters all publish a default now, so the value comes from " +
        `the contract: ${offenders.join("; ")}`,
    );
  });
});
