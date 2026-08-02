// #8988: the gate's own detection had never been tested, and the consequence
// was a regex requiring `new Set(` immediately — so every GENERICALLY-typed
// module-level collection was invisible to it. In a TypeScript codebase that is
// the common case, not an edge one: a `const x = new Set<string>()` with
// `.add()` calls passed a validator whose entire purpose is to catch that.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { mutableStateIn } from "../scripts/validate-module-state-resets.ts";

describe("mutableStateIn", () => {
  test("detects a plain collection that is mutated", () => {
    const src = `const seen = new Set();\nseen.add("x");`;
    assert.deepEqual(mutableStateIn(src), ["seen"]);
  });

  // The #8988 regression.
  test("detects a GENERICALLY-TYPED collection that is mutated", () => {
    for (const decl of [
      "const seen = new Set<string>();",
      "const memo = new Map<string, number>();",
      "const refs = new WeakSet<object>();",
    ]) {
      const name = decl.match(/const (\w+)/)![1];
      const src = `${decl}\n${name}.add("x");\n${name}.set("k", 1);`;
      assert.deepEqual(mutableStateIn(src), [name], decl);
    }
  });

  // A half-fix using `<[^>]*>` stops at the first `>` and misses this — which
  // is real code (workers/storage.ts's runManifestMemo), so the nested case
  // would have stayed exactly as blind as before.
  test("detects a NESTED generic collection", () => {
    const src = `const memo = new Map<string, Map<string, string> | null>();\nmemo.set("k", null);`;
    assert.deepEqual(mutableStateIn(src), ["memo"]);
  });

  test("detects a reassigned let", () => {
    const src = `let generation = 0;\ngeneration += 1;`;
    assert.deepEqual(mutableStateIn(src), ["generation"]);
  });

  // The other half: a frozen lookup table needs no reset, and flagging it would
  // push authors toward registering a reset that BREAKS the module by clearing
  // a build-once index.
  test("ignores a collection that is never mutated", () => {
    const src = `const TABLE = new Map<string, number>([["a", 1]]);\nTABLE.get("a");`;
    assert.deepEqual(mutableStateIn(src), []);
  });

  test("ignores a let that is only read", () => {
    const src = `let limit = 10;\nif (limit === 10) {}`;
    assert.deepEqual(mutableStateIn(src), []);
  });

  // Indented declarations are function-local, not module state.
  test("ignores non-top-level declarations", () => {
    const src = `function f() {\n  const seen = new Set<string>();\n  seen.add("x");\n}`;
    assert.deepEqual(mutableStateIn(src), []);
  });

  test("reports each name once", () => {
    const src = `const seen = new Set<string>();\nseen.add("a");\nseen.add("b");\nseen.delete("a");`;
    assert.deepEqual(mutableStateIn(src), ["seen"]);
  });
});
