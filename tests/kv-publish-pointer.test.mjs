import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

test("KV latest pointer uses immutable run prefix for Worker artifact reads", () => {
  const source = readFileSync("scripts/kv-publish-pointer.mjs", "utf8");

  assert.match(source, /latest_prefix: manifest\.run_prefix/);
  assert.doesNotMatch(source, /latest_prefix: manifest\.latest_prefix/);
  assert.match(source, /previous run-specific artifacts live/);
});
