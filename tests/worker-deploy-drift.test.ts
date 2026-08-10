// The deploy-drift verdicts (#10238).
//
// Between "merged" and "running" there was no automated relationship. A
// Workers Build that fails on the merge commit leaves main merged and
// production on the previous version, and nothing about that reads as an
// incident -- the PR is green and the branch is deleted.
//
// The rule has to distinguish three states that all look like "behind", and
// getting that wrong in either direction is the whole difficulty: alarm during
// every normal build and nobody reads the alarm (#9301); wait for a fixed SHA
// match and a genuinely failed build is indistinguishable from a slow one.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  DEPLOY_GRACE_MS,
  WORKER_CONFIGS,
  judgeDeploy,
  workerName,
} from "../scripts/check-worker-deploys.ts";

const MIN = 60_000;
const base = {
  config: "wrangler.data.jsonc",
  worker: "metagraphed-data-api",
  deployed: "9815e6a84d29",
  ancestor: true,
};

describe("the three states that all look like `behind`", () => {
  test("at HEAD is ok", () => {
    const v = judgeDeploy({ ...base, behind: 0, headAgeMs: 90 * MIN });
    assert.equal(v.verdict, "ok");
  });

  test("behind with a FRESH head is lagging, not a fault", () => {
    // Measured 2026-08-10, minutes after a merge: wss-lb was at HEAD while the
    // ~1 MB gzip data-api was three commits back. Demanding equality would
    // alarm on every merge for as long as the slowest build takes.
    const v = judgeDeploy({ ...base, behind: 3, headAgeMs: 9 * MIN });
    assert.equal(v.verdict, "lagging");
    assert.match(v.detail, /inside the 30m grace/);
  });

  test("behind with an OLD head is stale -- the failure this exists for", () => {
    const v = judgeDeploy({
      ...base,
      behind: 3,
      headAgeMs: DEPLOY_GRACE_MS + MIN,
    });
    assert.equal(v.verdict, "stale");
    assert.match(v.detail, /the build did not land/);
  });

  test("the boundary is the grace window, exactly", () => {
    // A bound nobody can locate is a bound nobody can reason about.
    const inside = judgeDeploy({
      ...base,
      behind: 1,
      headAgeMs: DEPLOY_GRACE_MS - 1,
    });
    const outside = judgeDeploy({
      ...base,
      behind: 1,
      headAgeMs: DEPLOY_GRACE_MS,
    });
    assert.equal(inside.verdict, "lagging");
    assert.equal(outside.verdict, "stale");
  });
});

describe("the states that are never merely slow", () => {
  test("a non-ancestor is FORKED however fresh main is", () => {
    // A deploy from a branch, or a rollback nobody recorded. Time cannot make
    // it right, so the grace window must not apply.
    const v = judgeDeploy({
      ...base,
      ancestor: false,
      behind: 0,
      headAgeMs: 0,
    });
    assert.equal(v.verdict, "forked");
  });

  test("no deployment record is UNKNOWN, never ok", () => {
    // "We could not read Cloudflare" and "the Worker is current" are different
    // claims and only one of them is safe to report as green.
    const v = judgeDeploy({
      ...base,
      deployed: null,
      ancestor: false,
      behind: 0,
      headAgeMs: 0,
    });
    assert.equal(v.verdict, "unknown");
    assert.match(v.detail, /no deployment record/);
  });
});

describe("the Worker list", () => {
  test("names every wrangler config in the repo", () => {
    // A Worker added without being listed here is invisible to the check --
    // exactly the silence the check exists to remove.
    assert.deepEqual([...WORKER_CONFIGS].sort(), [
      "wrangler.data.jsonc",
      "wrangler.jsonc",
      "wrangler.registry.jsonc",
      "wrangler.wss-lb.jsonc",
    ]);
  });

  test("each config's name is readable through the SHARED JSONC stripper", () => {
    // These configs hold route globs and cron expressions whose delimiters a
    // regex stripper splices across, and an https:// inside a string reads as a
    // comment. I wrote that regex first and it deleted a config (#10210 removed
    // the same mistake from the CI scripts).
    for (const config of WORKER_CONFIGS) {
      const name = workerName(config);
      assert.match(name, /^metagraphed/, `${config} -> ${name}`);
    }
  });
});
