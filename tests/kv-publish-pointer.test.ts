import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

test("existing deployment commands stage locally then commit one verified KV publication", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(
    pkg.scripts["r2:upload"],
    "node scripts/registry-kv-publish.ts --stage-only",
  );
  assert.equal(
    pkg.scripts["kv:publish"],
    "node scripts/kv-publish-pointer.ts --write",
  );
  const source = readFileSync("scripts/kv-publish-pointer.ts", "utf8");
  assert.match(source, /await publishRegistryMain\(\)/);
  assert.doesNotMatch(source, /r2ObjectExists|r2 object/);
});
