import assert from "node:assert/strict";
import { test } from "vitest";
import { canonicalJson } from "../scripts/ci-verify-submitted-artifacts.mjs";

test("artifact canonical JSON ignores object key order", () => {
  assert.equal(
    canonicalJson({ b: 2, a: { d: 4, c: 3 } }),
    canonicalJson({ a: { c: 3, d: 4 }, b: 2 }),
  );
});

test("artifact canonical JSON preserves semantic array order", () => {
  assert.notEqual(
    canonicalJson({ rows: [{ netuid: 0 }, { netuid: 1 }, { netuid: 2 }] }),
    canonicalJson({ rows: [{ netuid: 2 }, { netuid: 1 }, { netuid: 0 }] }),
  );
});
