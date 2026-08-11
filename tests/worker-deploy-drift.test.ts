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
  BUILD_TARGET_SEARCH_DEPTH,
  DEPLOY_GRACE_MS,
  newestCommitWithBuild,
  WORKER_CONFIGS,
  classifyDeployReadError,
  judgeDeploy,
  oldestUndeployedSha,
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
    const v = judgeDeploy({ ...base, behind: 0, undeployedAgeMs: 90 * MIN });
    assert.equal(v.verdict, "ok");
  });

  test("behind with a FRESH head is lagging, not a fault", () => {
    // Measured 2026-08-10, minutes after a merge: wss-lb was at HEAD while the
    // ~1 MB gzip data-api was three commits back. Demanding equality would
    // alarm on every merge for as long as the slowest build takes.
    const v = judgeDeploy({ ...base, behind: 3, undeployedAgeMs: 9 * MIN });
    assert.equal(v.verdict, "lagging");
    assert.match(v.detail, /inside the 30m grace/);
  });

  test("behind with an OLD head is stale -- the failure this exists for", () => {
    const v = judgeDeploy({
      ...base,
      behind: 3,
      undeployedAgeMs: DEPLOY_GRACE_MS + MIN,
    });
    assert.equal(v.verdict, "stale");
    assert.match(v.detail, /the build did not land/);
  });

  test("the boundary is the grace window, exactly", () => {
    // A bound nobody can locate is a bound nobody can reason about.
    const inside = judgeDeploy({
      ...base,
      behind: 1,
      undeployedAgeMs: DEPLOY_GRACE_MS - 1,
    });
    const outside = judgeDeploy({
      ...base,
      behind: 1,
      undeployedAgeMs: DEPLOY_GRACE_MS,
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
      undeployedAgeMs: 0,
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
      undeployedAgeMs: 0,
    });
    assert.equal(v.verdict, "unknown");
    assert.match(v.detail, /could not be read/);
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

describe("an unreadable deployment names WHICH kind of unreadable (#10357)", () => {
  // The first draft returned `unknown` with one message for every way the read
  // could fail, so an expired token and a hand-deployed Worker were the same
  // line of output. They have different owners: one needs a maintainer to
  // rotate a secret, the other needs nothing at all. The older check this
  // replaced (#5538) distinguished them, and that is the piece worth keeping.
  const unread = {
    ...base,
    deployed: null,
    behind: 0,
    undeployedAgeMs: 90 * MIN,
  };

  test("an auth failure says a maintainer has to fix the token", () => {
    const v = judgeDeploy({ ...unread, failure: "auth" });
    assert.equal(v.verdict, "unknown");
    assert.match(v.detail, /CLOUDFLARE_API_TOKEN/);
    assert.match(v.detail, /maintainer/);
  });

  test("a deployment with no SHA says it was not deployed by Workers Builds", () => {
    const v = judgeDeploy({ ...unread, failure: "no-commit-message" });
    assert.equal(v.verdict, "unknown");
    assert.match(v.detail, /wrangler deploy/);
    assert.doesNotMatch(v.detail, /CLOUDFLARE_API_TOKEN/);
  });

  test("the three details are mutually distinct, which is the point", () => {
    const details = (["auth", "no-commit-message", "unreadable"] as const).map(
      (failure) => judgeDeploy({ ...unread, failure }).detail,
    );
    assert.equal(new Set(details).size, 3, details.join(" | "));
  });

  test("an omitted reason still reads as unknown, never as ok", () => {
    // The caller may not know why. The one answer that must never appear here
    // is a verdict claiming the Worker is current.
    const v = judgeDeploy(unread);
    assert.equal(v.verdict, "unknown");
  });
});

describe("classifying wrangler's stderr", () => {
  // Real wrangler wordings. Matched on TEXT because `wrangler deployments
  // list` exits 1 for every failure, so the exit code carries nothing.
  test("recognises the auth failures", () => {
    for (const stderr of [
      "In a non-interactive environment, it is required to specify a Cloudflare API token",
      "✘ [ERROR] You are not logged in.",
      "Authentication error [code: 10000]",
      "A request to the Cloudflare API failed: Unauthorized",
      "Invalid API Token",
    ]) {
      assert.equal(classifyDeployReadError(stderr), "auth", stderr);
    }
  });

  test("does NOT claim auth for an unrelated failure", () => {
    // Over-matching is the worse direction: it would send someone to rotate a
    // token that is fine while the real fault goes unread.
    for (const stderr of [
      "✘ [ERROR] Could not find the config file wrangler.data.jsonc",
      "getaddrinfo ENOTFOUND api.cloudflare.com",
      "workerd/server/server.c++:1234: failed",
    ]) {
      assert.equal(classifyDeployReadError(stderr), "unreadable", stderr);
    }
  });
});

describe("the build target, not main's HEAD (#10370)", () => {
  // THE FALSE ALARM THIS CORRECTS. Workers Builds is PATH-FILTERED, so a merge
  // touching only scripts/, tests/ or migrations/ rebuilds nothing and the
  // deployed SHA legitimately sits behind main until that Worker's own inputs
  // change. Measured on main:
  //
  //   09517ffa  scripts + tests + migrations  ->  built: wss-lb only
  //   5524f90f  schemas-src                   ->  built: all four
  //
  // Comparing against HEAD reported `stale -- the build did not land` for a
  // Worker that was never asked to build. That is #9301: an alarm during
  // ordinary operation, which teaches people to ignore the alarm.
  //
  // The target is read from Cloudflare's OWN filtering decision -- the
  // `Workers Builds: <worker>` check run it leaves on a commit -- rather than
  // by reimplementing its watch paths here, which would be a second copy to
  // drift from the first.
  const runs: Record<string, string[]> = {
    c3: ["test", "Workers Builds: metagraphed-wss-lb"],
    c2: ["test"],
    c1: ["test", "Workers Builds: metagraphed-data-api"],
  };
  const lookup = (sha: string) => runs[sha] ?? [];

  test("skips commits that did not build this Worker", () => {
    assert.equal(
      newestCommitWithBuild("metagraphed-data-api", ["c3", "c2", "c1"], lookup),
      "c1",
    );
  });

  test("takes the newest one that did", () => {
    assert.equal(
      newestCommitWithBuild("metagraphed-wss-lb", ["c3", "c2", "c1"], lookup),
      "c3",
    );
  });

  test("a Worker that never built in the window is null, not the newest commit", () => {
    // Returning c3 here is the tempting shortcut and it is the bug again: it
    // would call a Worker current because something ELSE built.
    assert.equal(
      newestCommitWithBuild(
        "metagraphed-registry-sync-api",
        ["c3", "c2", "c1"],
        lookup,
      ),
      null,
    );
  });

  test("an unreadable commit is skipped, never treated as `never built`", () => {
    // null is "could not ask". Letting one transient API failure end the walk
    // would silently move the target to an older commit.
    const flaky = (sha: string) => (sha === "c3" ? null : (runs[sha] ?? []));
    assert.equal(
      newestCommitWithBuild("metagraphed-wss-lb", ["c3", "c2", "c1"], flaky),
      null,
      "wss-lb only built at c3, which was unreadable",
    );
    assert.equal(
      newestCommitWithBuild("metagraphed-data-api", ["c3", "c2", "c1"], flaky),
      "c1",
      "and the walk continued past it",
    );
  });

  test("an exact name match, not a prefix", () => {
    // "Workers Builds: metagraphed" must not satisfy "metagraphed-data-api",
    // nor the reverse -- the main Worker and data-api differ by a suffix.
    const only = (): string[] => ["Workers Builds: metagraphed"];
    assert.equal(
      newestCommitWithBuild("metagraphed-data-api", ["c1"], only),
      null,
    );
    assert.equal(newestCommitWithBuild("metagraphed", ["c1"], only), "c1");
  });

  test("the search depth is bounded and stated", () => {
    assert.ok(BUILD_TARGET_SEARCH_DEPTH >= 10);
    assert.ok(BUILD_TARGET_SEARCH_DEPTH <= 100);
  });
});

// #10597: the verdict logic was never wrong. It was handed the wrong commit.
//
// The grace window was measured against the BUILD TARGET -- the newest commit
// that should have built -- so on a repo with steady merges it reset on every
// merge and `stale` required main to go quiet for a full thirty minutes.
// Measured: `metagraphed` sat 6 commits behind with three consecutive failed
// builds over 58 minutes and the check exited 0, because somebody had merged
// ten minutes earlier. Activity silenced the alarm.
//
// judgeDeploy tests cannot catch that -- they pass whichever number they are
// given. This pins the derivation instead.
describe("which undeployed commit the grace window is measured against", () => {
  // rev-list prints newest-first.
  const NEWEST = "c8bf0843139028c9e6e3d44d7cb4c660f4cf9872";
  const MIDDLE = "005dd7e16a1b2c3d4e5f60718293a4b5c6d7e8f9";
  const OLDEST = "c424b1b66e45412bedb952b849fa3a97bdb1aa07";

  test("takes the OLDEST undeployed commit, not the newest", () => {
    assert.equal(
      oldestUndeployedSha([NEWEST, MIDDLE, OLDEST].join("\n")),
      OLDEST,
    );
  });

  test("a single undeployed commit is both newest and oldest", () => {
    assert.equal(oldestUndeployedSha(NEWEST), NEWEST);
  });

  test("nothing undeployed yields null rather than an empty sha", () => {
    // An empty string here would be handed to `git log -1 ''`, which resolves
    // to HEAD -- a silent wrong answer instead of "there is nothing to age".
    assert.equal(oldestUndeployedSha(""), null);
    assert.equal(oldestUndeployedSha("\n\n"), null);
  });

  // The property that actually failed, stated end to end: a fresh merge must
  // not rescue a Worker whose oldest undeployed commit is past the window.
  test("a fresh merge does not reset the window on an old freeze", () => {
    const oldest = oldestUndeployedSha([NEWEST, MIDDLE, OLDEST].join("\n"))!;
    assert.equal(oldest, OLDEST, "must age the freeze, not the newest merge");
    const verdict = judgeDeploy({
      ...base,
      behind: 3,
      undeployedAgeMs: 58 * MIN,
    });
    assert.equal(verdict.verdict, "stale");
  });
});
