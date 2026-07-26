import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

// #8276: the pointer's latest_prefix is what workers/storage.ts's latestR2Key
// concatenates the artifact path onto, so it MUST name a prefix r2-upload
// actually writes. It named manifest.run_prefix until #8237 content-addressed
// the history tier (runs/<run>/<path> -> by-hash/<sha256>), at which point the
// run prefix stopped being written and every live artifact read 404'd in
// production. Pin it to latest_prefix -- the only complete tree the upload
// still produces -- so that swap can't silently come back.
test("KV latest pointer resolves reads through a prefix the upload writes", () => {
  const source = readFileSync("scripts/kv-publish-pointer.ts", "utf8");

  assert.match(source, /latest_prefix: manifest\.latest_prefix/);
  assert.doesNotMatch(source, /latest_prefix: manifest\.run_prefix/);
  // run_prefix is still published as provenance (which run produced this
  // content), just no longer used to resolve reads.
  assert.match(source, /run_prefix: manifest\.run_prefix/);
  // metagraph:latest is the only KV control record now (dead feature-flags /
  // endpoint-pools / source-freshness sidecars were removed — read by nothing).
  assert.match(source, /\["metagraph:latest", pointer\]/);
  assert.doesNotMatch(source, /metagraph:feature-flags/);
});

// The regression this guards is a mismatch between two files, so assert the
// other half too: r2-upload must still populate the latest/ tree for every
// artifact. If the history rework ever swallows the latest tier as well, the
// pointer above would again name a prefix nothing writes.
test("r2-upload still writes a latest-tier object for every artifact", () => {
  const source = readFileSync("scripts/r2-upload.ts", "utf8");

  assert.match(source, /latest_key/);
  assert.match(source, /uploaded_latest_count/);
});
