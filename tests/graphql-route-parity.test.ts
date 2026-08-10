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
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vitest";

const SCRIPT = "scripts/validate-graphql-route-parity.ts";

function run() {
  return execFileSync("node", [SCRIPT], { encoding: "utf8" });
}

/**
 * Each declared-exemption map and the file that owns it.
 *
 * `DECLARED_ARGUMENTS` moved to `schemas-src/` (#10316) because the runtime
 * needs it too: the GraphQL dispatch parse has to skip an argument the two
 * surfaces legitimately spell differently, and `src/` cannot import from
 * `scripts/`. This test follows it rather than pinning it to the gate -- what
 * matters is that every entry carries a written reason, not which file it
 * sits in.
 */
const DECLARED_MAPS = [
  { name: "DECLARED", file: SCRIPT },
  {
    name: "DECLARED_ARGUMENTS",
    file: "schemas-src/graphql/argument-divergences.ts",
  },
  { name: "DECLARED_MISSING_ARGUMENTS", file: SCRIPT },
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
    for (const { name, file } of DECLARED_MAPS) {
      const source = readFileSync(file, "utf8");
      const block =
        new RegExp(
          `const ${name}: (?:Readonly<Record<string, string>>|Record<string, string>) = \\{([\\s\\S]*?)\\n\\};`,
        ).exec(source) ??
        // An EMPTY map is the goal state, not a missing one: every gap it
        // recorded has been closed. `{}` on one line does not match the
        // multi-line shape above, so accept it explicitly rather than
        // reporting the finished job as a broken gate.
        (new RegExp(
          `const ${name}: (?:Readonly<Record<string, string>>|Record<string, string>) = \\{\\};`,
        ).test(source)
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

// ── the network twin, in the reverse direction (#10394) ──────────────────────
//
// The forward rule exempts a `network` ARGUMENT because the twin path is how
// that parameter is spelled. The reverse loop could not represent the opposite
// -- a route with a twin whose Query field takes no `network` -- because on the
// twin `network` is `in: "path"` and on the base path it does not appear at
// all. Twenty fields sat in that blind spot: testnet reachable over REST,
// unreachable over GraphQL, and the gate reporting zero divergences.
describe("the network twin's reverse check", () => {
  test("FAILS when a field drops the network argument its route twins", () => {
    const sdl = readFileSync("src/graphql-sdl.ts", "utf8");
    // `blocks` mirrors /api/v1/blocks, which has a /api/v1/{network}/blocks
    // twin. Removing its argument must be reported, not passed over.
    const broken = sdl.replace(
      "\n      network: Network\n    ): BlockList!",
      "\n    ): BlockList!",
    );
    assert.notEqual(broken, sdl, "the fixture argument must exist to remove");
    const path = join(mkdtempSync(join(tmpdir(), "sdl-")), "graphql-sdl.ts");
    writeFileSync(path, broken);
    assert.throws(
      () =>
        execFileSync("node", [SCRIPT], {
          encoding: "utf8",
          env: { ...process.env, GRAPHQL_SDL_PATH: path },
        }),
      (err: unknown) => {
        const e = err as { stdout?: string; stderr?: string };
        const output = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
        assert.match(output, /blocks\.network/);
        assert.match(output, /has a \/\{network\}\/ twin/);
        return true;
      },
    );
  });

  test("the real SDL passes it -- all twenty forward the argument", () => {
    assert.match(run(), /0 divergence\(s\)/);
  });
});
