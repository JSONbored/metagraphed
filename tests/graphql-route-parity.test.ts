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

const DECLARED_MAPS = [
  "DECLARED",
  "DECLARED_ARGUMENTS",
  "DECLARED_MISSING_ARGUMENTS",
] as const;

describe("graphql route parity gate", () => {
  test("passes on the committed contract", () => {
    // Both halves, separately. `0 divergence(s)` appears on two summary lines
    // now, so matching it once would let the argument half regress unnoticed
    // while the type half kept the assertion green.
    const output = run();
    assert.match(
      output,
      /type\/route pairs, \d+ fields compared, 0 divergence/,
    );
    assert.match(output, /argument\/parameter pairs, 0 divergence/);
  });

  test("the comparison actually reaches the SDL", () => {
    // A gate that resolves no pairs passes while checking nothing. The script
    // has its own floor for this; this pins the same property from outside so
    // lowering the floor alone cannot hide a broken merge.
    //
    // The floors moved with #10065: the parser read argument lines as fields,
    // so every Query field with a multi-line argument list was skipped and the
    // gate compared 105 pairs while believing it covered the schema. 160/1088
    // is the whole surface; anything materially under it means the parse broke
    // again.
    const output = run();
    const pairs = /(\d+) type\/route pairs/.exec(output);
    const fields = /(\d+) fields compared/.exec(output);
    const args = /(\d+) argument\/parameter pairs/.exec(output);
    assert.ok(pairs && Number(pairs[1]) >= 155, `pairs: ${pairs?.[1]}`);
    assert.ok(fields && Number(fields[1]) >= 1050, `fields: ${fields?.[1]}`);
    assert.ok(args && Number(args[1]) >= 600, `arguments: ${args?.[1]}`);
  });

  test("multi-line argument lists are parsed, not read as fields", () => {
    // The specific parse bug the floors above are a proxy for. `subnets(` opens
    // an argument list spanning 30 lines; if those lines are read as fields of
    // Query, `Query.sort`, `Query.order` and friends appear as phantom fields
    // and the field they belong to vanishes. Assert the shape directly so a
    // reader can see what the floor is protecting.
    const sdl = readFileSync("src/graphql-sdl.ts", "utf8");
    const query = /^ {2}type Query \{\n([\s\S]*?)^ {2}\}/m.exec(sdl);
    assert.ok(query, "the SDL must still declare `type Query`");
    const multiLine = [...query[1].matchAll(/^ {4}(\w+)\($/gm)];
    assert.ok(
      multiLine.length >= 60,
      `only ${multiLine.length} multi-line-argument Query fields found — if this ` +
        "collapsed, the gate's coverage claim rests on a shape that no longer exists",
    );
  });

  test("every declared divergence carries a written reason", () => {
    // A bare marker would let an entry be added without saying why, which is
    // how an allowlist stops being evidence and becomes a place to put things.
    // A reason may be an inline string or a shared constant (several entries
    // share one paragraph); a shared constant must itself be prose.
    const source = readFileSync(SCRIPT, "utf8");
    for (const name of DECLARED_MAPS) {
      const block =
        new RegExp(
          `const ${name}: Record<string, string> = \\{([\\s\\S]*?)\\n\\};`,
        ).exec(source) ??
        // An EMPTY map is the goal state, not a missing one: every gap it
        // recorded has been closed. `{}` on one line does not match the
        // multi-line shape above, so accept it explicitly rather than
        // reporting the finished job as a broken gate.
        (new RegExp(`const ${name}: Record<string, string> = \\{\\};`).test(
          source,
        )
          ? ([source, ""] as unknown as RegExpExecArray)
          : null);
      assert.ok(block, `${name} must stay a hand-written map`);
      for (const [, key, reason] of block[1].matchAll(
        /"([\w.]+)":\s*\n?\s*("|[A-Z_]+,)/g,
      )) {
        if (reason === '"') continue;
        const constant = reason.replace(/,$/, "");
        assert.match(
          source,
          new RegExp(`const ${constant} =\\s*\\n?\\s*"`),
          `${key} points at ${constant}, which must be a prose constant`,
        );
      }
      const keys = [...block[1].matchAll(/"([\w.]+)":/g)].length;
      const reasons = [...block[1].matchAll(/"[\w.]+":\s*\n?\s*("|[A-Z_]+)/g)]
        .length;
      assert.equal(reasons, keys, `every ${name} entry needs a reason`);
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
