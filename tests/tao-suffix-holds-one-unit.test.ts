// #10514: inside one payload, the `_tao` suffix means one thing.
//
// #8945 left per-row `stake_tao`/`emission_tao` under the on-chain column name,
// reasoning that the denominating `netuid` sits in the same object so a reader
// can tell. That holds -- until a PRICED `total_stake_tao` sits in the same
// object too. Then the payload carries two fields with the same suffix and
// different units, and the reader who sums the rows does not reach the total.
// A field description cannot fix that: the name is what gets read.
//
// So the rule is structural rather than a list of exceptions: no published
// object may carry a priced `total_*_tao` alongside a descendant row that
// carries `stake_tao` / `emission_tao`. Where both are wanted, the ROW renames
// to `_alpha`, because the row is the one that is alpha.
//
// This is a GATE, not a snapshot. A new route that reintroduces the pair fails
// here rather than shipping the trap again, which is the part #8945's prose
// could not do -- and the reason the four payloads it left were found by this
// scan rather than by reading.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";

type Row = Record<string, unknown>;

const spec = JSON.parse(
  readFileSync("public/metagraph/openapi.json", "utf8"),
) as Row;
const components = ((spec.components as Row)?.schemas ?? {}) as Record<
  string,
  Row
>;

/** The priced cross-subnet totals. Each is genuinely TAO (#9051). */
const PRICED_TOTALS = ["total_stake_tao", "total_emission_tao"];
/** The row-level fields that are alpha on every non-root subnet (#2550). */
const ALPHA_ROWS = ["stake_tao", "emission_tao"];

function deref(node: unknown, depth = 0): Row {
  let current = node as Row;
  let hops = depth;
  while (
    current &&
    typeof current === "object" &&
    typeof current.$ref === "string" &&
    hops < 10
  ) {
    current = components[String(current.$ref).split("/").pop() ?? ""] ?? {};
    hops += 1;
  }
  return current && typeof current === "object" ? current : {};
}

function properties(node: unknown): Record<string, unknown> {
  return (deref(node).properties ?? {}) as Record<string, unknown>;
}

/** Every descendant path under `node` whose object carries an alpha row field. */
function alphaRowsUnder(node: unknown, prefix = "", depth = 0): string[] {
  if (depth > 4) return [];
  const props = properties(node);
  const found: string[] = [];
  const own = ALPHA_ROWS.filter((field) => field in props);
  if (own.length > 0 && prefix) found.push(`${prefix} (${own.join(", ")})`);
  for (const [key, value] of Object.entries(props)) {
    const resolved = deref(value);
    const next = prefix ? `${prefix}.${key}` : key;
    if (resolved.type === "array") {
      found.push(...alphaRowsUnder(resolved.items, `${next}[]`, depth + 1));
    } else if (resolved.properties) {
      found.push(...alphaRowsUnder(resolved, next, depth + 1));
    }
  }
  return found;
}

/** Every (schema, path) where a priced total and an alpha row share a payload. */
function collisions(): string[] {
  const out: string[] = [];
  const visit = (node: unknown, path: string, depth = 0) => {
    if (depth > 7) return;
    const props = properties(node);
    if (PRICED_TOTALS.some((total) => total in props)) {
      for (const row of alphaRowsUnder(node)) out.push(`${path}.${row}`);
    }
    for (const [key, value] of Object.entries(props)) {
      const resolved = deref(value);
      if (resolved.type === "array") {
        visit(resolved.items, `${path}.${key}[]`, depth + 1);
      } else if (resolved.properties) {
        visit(resolved, `${path}.${key}`, depth + 1);
      }
    }
  };
  for (const [name, node] of Object.entries(components)) visit(node, name);
  return [...new Set(out)].sort();
}

describe("the `_tao` suffix means one unit within a payload (#10514)", () => {
  test("no payload carries a priced total beside an alpha row", () => {
    assert.deepEqual(
      collisions(),
      [],
      "these publish a priced `total_*_tao` in the same object as a row-level " +
        "`stake_tao`/`emission_tao`, which is alpha on every non-root subnet. " +
        "A consumer summing the rows does not reach the total. Rename the ROW " +
        "to `_alpha` -- the row is the one that is alpha:\n  " +
        collisions().join("\n  "),
    );
  });

  test("the scan can actually SEE a collision", () => {
    // Without this, the gate above passes on a scanner that resolves nothing --
    // and it would have, silently, for as long as the $ref hops were wrong.
    const before = Object.keys(components).length;
    const probe = {
      properties: {
        total_stake_tao: { type: "number" },
        rows: {
          type: "array",
          items: { properties: { stake_tao: { type: "number" } } },
        },
      },
    };
    const found = alphaRowsUnder(probe);
    assert.deepEqual(found, ["rows[] (stake_tao)"]);
    assert.equal(
      Object.keys(components).length,
      before,
      "the probe must not mutate the spec it scans",
    );
  });

  test("the scan resolves $ref, not just inline shapes", () => {
    // Every real payload nests through a $ref. A scanner that only walked
    // inline objects would report NOTHING and look exactly like a clean spec.
    const name = Object.keys(components)[0]!;
    assert.ok(
      Object.keys(properties({ $ref: `#/components/schemas/${name}` })).length >
        0,
      "a $ref must resolve to the component's own properties",
    );
  });

  test("the renamed rows are actually published", () => {
    // The other half: the rename landed, rather than the fields being dropped.
    // A deleted field would also make the collision scan pass.
    const published = JSON.stringify(spec);
    for (const field of ["stake_alpha", "emission_alpha"]) {
      assert.ok(
        published.includes(`"${field}"`),
        `${field} must be published somewhere -- the collision is fixed by a ` +
          "rename, not by removing the row",
      );
    }
  });
});
