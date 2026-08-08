// The GraphQL↔route parity gate's own invariants (#9889).
//
// `validate:graphql-route-parity` compares every SDL type against the route its
// doc comment says it mirrors. The script's behaviour was verified by injecting
// a divergence and watching it reject: reverting the `emission_concentration`
// fix makes it report that field and exit non-zero.
//
// This pins the properties that make it worth running, because the failure mode
// of a schema-comparison gate is silence — the allOf merge breaks, zero pairs
// resolve, and it prints a clean bill of health forever.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";

const SCRIPT = "scripts/validate-graphql-route-parity.ts";

function run() {
  return execFileSync("node", [SCRIPT], { encoding: "utf8" });
}

describe("graphql route parity gate", () => {
  test("passes on the committed contract", () => {
    // Not just an exit code: the summary line carries the counts the rest of
    // this file asserts against.
    assert.match(run(), /0 divergence\(s\)/);
  });

  test("the comparison actually reaches the SDL", () => {
    // A gate that resolves no pairs passes while checking nothing. The script
    // has its own floor for this; this pins the same property from outside so
    // lowering the floor alone cannot hide a broken merge.
    const output = run();
    const pairs = /(\d+) type\/route pairs/.exec(output);
    const fields = /(\d+) fields compared/.exec(output);
    assert.ok(pairs && Number(pairs[1]) >= 100, `pairs: ${pairs?.[1]}`);
    assert.ok(fields && Number(fields[1]) >= 700, `fields: ${fields?.[1]}`);
  });

  test("every declared divergence carries a written reason", () => {
    // A bare marker would let an entry be added without saying why, which is
    // how an allowlist stops being evidence and becomes a place to put things.
    const source = readFileSync(SCRIPT, "utf8");
    const block =
      /const DECLARED: Record<string, string> = \{([\s\S]*?)\n\};/.exec(source);
    assert.ok(block, "DECLARED must stay a hand-written map");
    for (const [, key] of block[1].matchAll(/"([\w.]+)":/g)) {
      const entry = new RegExp(`"${key.replace(".", "\\.")}":\\s*\\n?\\s*"`);
      assert.match(source, entry, `${key} must carry a prose reason`);
    }
  });

  test("the SDL still annotates the routes it mirrors", () => {
    // The whole mapping hangs off `Mirrors GET /api/v1/…` in the doc comments.
    // If those were dropped in a reformat the gate would silently compare
    // nothing, so pin that the annotation is still widespread.
    const sdl = readFileSync("src/graphql-sdl.ts", "utf8");
    const annotations = [...sdl.matchAll(/Mirrors GET \/api\/v1\//g)].length;
    assert.ok(annotations > 200, `only ${annotations} route annotations left`);
  });
});
