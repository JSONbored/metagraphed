// The three gates #10790 lands, each shown REPORTING as well as passing.
//
// This epic has now met several CI gates that were green because they were
// looking at nothing, and one of them was in this very PR: the first cut of
// `report-shape-duplicate-drift.ts` matched the enclosing object literal
// rather than the declaration at the reported line, so every field read
// `<absent>` on both sides and it announced "45 identical, 0 divergent" --
// a clean bill of health produced by comparing nothing. The truth was the
// reverse: 42 of the 45 disagree.
//
// So each gate here is driven twice: with input it must flag, and with input
// it must not. A test that only ever asserts zero would have passed against
// that broken extractor.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "vitest";
import { findPassthroughCalls } from "../scripts/validate-no-passthrough.ts";
import {
  findDuplicates,
  findObjectShapes,
} from "../scripts/validate-schema-shape-duplicates.ts";
import { findDrift } from "../scripts/report-shape-duplicate-drift.ts";

/**
 * A throwaway file under the repo root, because all three gates resolve their
 * inputs relative to it. Returns the repo-relative path they take.
 */
function fixture(name: string, source: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "strictness-"));
  const file = path.join(dir, name);
  writeFileSync(file, source, "utf8");
  return path.relative(
    path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."),
    file,
  );
}

describe("no-passthrough", () => {
  test("finds a `.passthrough()` call, with its line", () => {
    const file = fixture(
      "open.ts",
      [
        "import { z } from 'zod';",
        "",
        "export const A = z",
        "  .object({})",
        "  .passthrough();",
        "",
      ].join("\n"),
    );
    const sites = findPassthroughCalls([file]);
    assert.equal(sites.length, 1);
    assert.equal(sites[0]!.line, 3, "the call's own start line");
  });

  test("does NOT fire on `.catchall()`, which is the declared alternative", () => {
    const file = fixture(
      "declared.ts",
      "import { z } from 'zod';\nexport const A = z.object({}).catchall(z.unknown());\n",
    );
    assert.deepEqual(findPassthroughCalls([file]), []);
  });

  test("does NOT fire on the word in a comment or a string", () => {
    // The reason this gate reads the AST: fifteen mentions in this tree are
    // prose explaining why a site was flipped, and a regex gate failing on its
    // own documentation would be fixed by deleting the documentation.
    const file = fixture(
      "prose.ts",
      [
        "import { z } from 'zod';",
        "// This used to be `.passthrough()` before #10790.",
        "export const NOTE = 'passthrough()';",
        "export const A = z.object({}).strict();",
      ].join("\n"),
    );
    assert.deepEqual(findPassthroughCalls([file]), []);
  });
});

describe("schema-shape-duplicates", () => {
  const twoFiles = (bodyA: string, bodyB: string) => [
    fixture(
      "a.ts",
      `import { z } from 'zod';\nexport const A = z.object({\n${bodyA}\n});\n`,
    ),
    fixture(
      "b.ts",
      `import { z } from 'zod';\nexport const B = z.object({\n${bodyB}\n});\n`,
    ),
  ];

  const FOUR =
    "  a: z.string(),\n  b: z.string(),\n  c: z.string(),\n  d: z.string(),";

  test("reports one key set declared in two files", () => {
    const duplicates = findDuplicates(findObjectShapes(twoFiles(FOUR, FOUR)));
    assert.equal(duplicates.length, 1);
    assert.equal(duplicates[0]!.keys, "a,b,c,d");
  });

  test("is silent below four keys -- three recur by coincidence", () => {
    const three = "  a: z.string(),\n  b: z.string(),\n  c: z.string(),";
    assert.deepEqual(
      findDuplicates(findObjectShapes(twoFiles(three, three))),
      [],
    );
  });

  test("is silent when the key sets differ by one", () => {
    const other = `${FOUR}\n  e: z.string(),`;
    assert.deepEqual(
      findDuplicates(findObjectShapes(twoFiles(FOUR, other))),
      [],
    );
  });

  test("is silent for two literals in ONE file", () => {
    // A schema and its history variant sharing a point shape, declared side by
    // side where a reader sees both. The failure this gate exists for is the
    // copy in another file, which no reader of either sees.
    const file = fixture(
      "pair.ts",
      `import { z } from 'zod';\nexport const A = z.object({\n${FOUR}\n});\nexport const B = z.object({\n${FOUR}\n});\n`,
    );
    assert.deepEqual(findDuplicates(findObjectShapes([file])), []);
  });
});

describe("shape-duplicate-drift", () => {
  const pair = (bodyA: string, bodyB: string) =>
    findDrift(
      findDuplicates(
        findObjectShapes([
          fixture(
            "a.ts",
            `import { z } from 'zod';\nexport const A = z.object({\n${bodyA}\n});\n`,
          ),
          fixture(
            "b.ts",
            `import { z } from 'zod';\nexport const B = z.object({\n${bodyB}\n});\n`,
          ),
        ]),
      ),
    );

  const BASE =
    "  a: z.string(),\n  b: z.string(),\n  c: z.string(),\n  d: z.string(),";

  test("calls two identical declarations identical", () => {
    const [drift] = pair(BASE, BASE);
    assert.equal(drift!.divergent.size, 0);
  });

  test("names the field two declarations disagree about", () => {
    // The case the migration turns on: same key set, different type. Collapsing
    // these is a published-contract change, not a cleanup.
    const [drift] = pair(BASE, BASE.replace("b: z.string()", "b: z.int()"));
    assert.deepEqual([...drift!.divergent.keys()], ["b"]);
    assert.deepEqual(drift!.divergent.get("b"), ["z.string()", "z.int()"]);
  });

  test("a differing `.describe()` alone is NOT drift", () => {
    // Prose differing between two copies is worth fixing and is not a contract
    // change; leaving it in would bury the type differences that are.
    const [drift] = pair(
      BASE,
      BASE.replace("b: z.string()", "b: z.string().describe('a note')"),
    );
    assert.equal(drift!.divergent.size, 0);
  });

  test("requiredness counts as drift", () => {
    const [drift] = pair(
      BASE,
      BASE.replace("b: z.string()", "b: z.string().optional()"),
    );
    assert.deepEqual([...drift!.divergent.keys()], ["b"]);
  });

  test("an extraction that reads the wrong literal FAILS LOUDLY", () => {
    // The bug this file was written for. If the extractor ever again matches
    // something other than the declaration at the reported line, its key set
    // will not be the gate's key set -- and the report must say so rather than
    // report "identical" from a comparison of nothing.
    const [drift] = pair(BASE, BASE);
    for (const key of drift!.keys.split(",")) {
      assert.ok(
        !key.startsWith("<EXTRACTION FAILED"),
        "a clean pair must not be reported as an extraction failure",
      );
    }
    // And the guard is real: it keys on the extracted set matching the gate's.
    assert.equal(drift!.keys, "a,b,c,d");
  });
});
