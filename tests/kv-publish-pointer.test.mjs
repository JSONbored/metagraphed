import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

test("KV latest pointer uses immutable run prefix for Worker artifact reads", () => {
  const source = readFileSync("scripts/kv-publish-pointer.mjs", "utf8");

  assert.match(source, /latest_prefix: manifest\.run_prefix/);
  assert.doesNotMatch(source, /latest_prefix: manifest\.latest_prefix/);
  assert.match(source, /immutable run prefix/);
  // metagraph:latest is the only KV control record now (dead feature-flags /
  // endpoint-pools / source-freshness sidecars were removed — read by nothing).
  assert.match(source, /\["metagraph:latest", pointer\]/);
  assert.doesNotMatch(source, /metagraph:feature-flags/);
});
