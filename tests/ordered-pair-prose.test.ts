// A published ORDERED PAIR says which way round it goes (#10219).
//
// 41 pairs are published across the GET routes -- `from`/`to`,
// `block_start`/`block_end`, `since`/`until` -- and before this, not one said.
// JSON Schema cannot relate two sibling properties, so the relationship lived
// in the handler or nowhere, and a caller reading the contract could not tell
// an ordered pair from two independent filters.
//
// STATED, NOT ENFORCED, and that is the decision this pins. Measured across
// every route publishing a pair: 20 reject an inverted range and 12 answer an
// empty page, and the 12 are deliberate -- an inverted range provably matches
// nothing, so skipping the read is the point, and nine tests pin exactly that.
// A `.refine()` would flip all twelve to rejecting: a behaviour change on
// twelve routes made by a refactor rather than by a decision. The sentence
// makes the pair legible without touching what either surface does with it.
//
// ONE DECLARATION, three readers. `orderingNote(edge)` is the only place the
// sentence exists; `blockBoundSchema` and `daySchema` append it from the edge
// they already carry, and the feed routes compose it onto their own
// item-specific opening. A second copy is what this epic removes, so a test
// that merely checked "says something about ordering" would miss the failure
// that matters -- two halves of one pair disagreeing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import { orderingNote } from "../schemas-src/query-params.ts";

interface Parameter {
  name: string;
  description?: string;
  schema?: { description?: string };
}

/** The two halves of every ordered pair this API publishes. */
const PAIRS: readonly (readonly [string, string])[] = [
  ["from", "to"],
  ["block_start", "block_end"],
  ["start_date", "end_date"],
  ["since", "until"],
  ["after", "before"],
];

const spec = JSON.parse(
  readFileSync("public/metagraph/openapi.json", "utf8"),
) as {
  paths: Record<string, Record<string, { parameters?: Parameter[] }>>;
};

const prose = (parameter: Parameter): string =>
  parameter.description ?? parameter.schema?.description ?? "";

function publishedPairs(): {
  route: string;
  lower: Parameter;
  upper: Parameter;
}[] {
  const found: { route: string; lower: Parameter; upper: Parameter }[] = [];
  for (const [route, methods] of Object.entries(spec.paths)) {
    const parameters = methods.get?.parameters ?? [];
    const byName = new Map(parameters.map((p) => [p.name, p]));
    for (const [lo, hi] of PAIRS) {
      const lower = byName.get(lo);
      const upper = byName.get(hi);
      if (lower && upper) found.push({ route, lower, upper });
    }
  }
  return found;
}

describe("every published ordered pair states its ordering", () => {
  test("both halves carry the note, and it is the shared one", () => {
    const pairs = publishedPairs();
    // 41 today. The floor guards against the scan quietly matching nothing --
    // a "no pair is silent" assertion passes perfectly when no pair is found.
    assert.ok(
      pairs.length >= 40,
      `expected the pair scan to find the published pairs, got ${pairs.length}`,
    );

    const silent: string[] = [];
    for (const { route, lower, upper } of pairs) {
      if (!prose(lower).endsWith(orderingNote("first"))) {
        silent.push(`${route} ${lower.name} (lower)`);
      }
      if (!prose(upper).endsWith(orderingNote("last"))) {
        silent.push(`${route} ${upper.name} (upper)`);
      }
    }
    assert.deepEqual(
      silent,
      [],
      `these publish one half of an ordered pair without saying which way it ` +
        `goes:\n  ${silent.join("\n  ")}\n` +
        "Build the bound with `blockBoundSchema`/`daySchema`, or append " +
        "`orderingNote(edge)` to the route's own prose. Do not write the " +
        "sentence out -- one declaration is what keeps 41 pairs agreeing.",
    );
  });

  test("the two halves say OPPOSITE things", () => {
    // The failure a "says something about ordering" check would miss: both
    // halves carrying the lower-bound sentence reads as consistent and is
    // exactly backwards for one of them.
    assert.notEqual(orderingNote("first"), orderingNote("last"));
    assert.match(orderingNote("first"), /not be later/);
    assert.match(orderingNote("last"), /not be earlier/);
  });
});
