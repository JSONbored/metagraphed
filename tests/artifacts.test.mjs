import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

function runNode(script) {
  execFileSync(process.execPath, [script], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "pipe"
  });
}

test("registry validates", () => {
  runNode("scripts/validate.mjs");
});

test("artifact build emits public indexes", () => {
  runNode("scripts/build-artifacts.mjs");

  const native = JSON.parse(readFileSync("registry/native/finney-subnets.json", "utf8"));
  const subnets = JSON.parse(readFileSync("public/metagraph/subnets.json", "utf8"));
  const surfaces = JSON.parse(readFileSync("public/metagraph/surfaces.json", "utf8"));
  const candidates = JSON.parse(readFileSync("public/metagraph/candidates.json", "utf8"));
  const reviewQueue = JSON.parse(readFileSync("public/metagraph/review-queue.json", "utf8"));
  const health = JSON.parse(readFileSync("public/metagraph/health/latest.json", "utf8"));
  const coverage = JSON.parse(readFileSync("public/metagraph/coverage.json", "utf8"));

  assert.equal(subnets.subnets.length, native.subnets.length);
  assert.equal(surfaces.surfaces.length, 16);
  assert.equal(health.surfaces.length, 16);
  assert.equal(coverage.chain_subnet_count, native.subnets.length);
  assert.equal(coverage.curated_overlay_count, 2);
  assert.equal(coverage.candidate_count, candidates.candidates.length);
  assert.equal(coverage.candidate_subnet_count, native.subnets.length);
  assert.equal(reviewQueue.count, reviewQueue.candidates.length);
  assert.equal(reviewQueue.candidates.length, candidates.candidates.length);
  assert.equal(coverage.probed_count, 2);
  assert.equal(coverage.native_only_count, native.subnets.length - 2);
  assert.deepEqual(
    subnets.subnets.map((subnet) => subnet.netuid),
    native.subnets.map((subnet) => subnet.netuid)
  );
  assert.equal(subnets.subnets.find((subnet) => subnet.netuid === 0).subnet_type, "root");
  assert.equal(subnets.subnets.find((subnet) => subnet.netuid === 7).coverage_level, "probed");
  assert.equal(subnets.subnets.find((subnet) => subnet.netuid === 74).coverage_level, "probed");

  for (const subnet of native.subnets) {
    assert.equal(existsSync(`public/metagraph/subnets/${subnet.netuid}.json`), true);
  }
});
