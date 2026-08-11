// Is what production is RUNNING the code that was merged? (#10238)
//
// ## The gap this closes
//
// Workers Builds is the deploy path, and a build that fails on the merge commit
// leaves `main` merged and production running the previous version with nothing
// that reads as an incident: the PR is green, the branch is deleted, and the
// only symptom is that the fix does not take effect. `metagraphed-data-api`
// failed twice on 2026-08-08 and passed on retry with a byte-identical diff, so
// this is observed rather than hypothetical.
//
// Between "landed" and "running" there was no automated relationship at all --
// the same shape as #10190 and #9779.
//
// ## Why this cannot be a Worker cron, unlike every other watchdog here
//
// A Worker that failed to deploy is RUNNING THE PREVIOUS VERSION, so asking it
// what it is running gets the previous version's answer, confidently. The check
// has to observe from outside the thing it is checking -- the same reasoning as
// "a Worker cannot probe its own route", one level up.
//
// It reads Cloudflare's own record instead: Workers Builds stamps the commit
// SHA as the deployment message, so nothing has to be injected at build time
// and no bundle changes.
//
// ## THERE IS A CLEANER PATH, and it is one deploy flag away
//
// Every Worker here already binds CF_VERSION_METADATA, which hands the runtime
// its own version `{id, tag, timestamp}` with NO credential and NO API call.
// That would let each Worker self-report, and a checker would need nothing from
// Cloudflare's control plane at all.
//
// It does not work TODAY for one narrow reason: Workers Builds puts the commit
// SHA in the deployment MESSAGE, and the binding exposes the TAG, which is
// empty --
//
//     Tag:      -
//     Message:  ea6baa13cbb4747861fc7f8893b7dd0a92958f03
//
// Set the tag to the SHA at deploy and this script's Cloudflare read collapses
// into a binding read. Worth doing; it is a deploy-configuration change rather
// than a token, and it is tracked on #10238.
//
// ## The three verdicts, and why "behind" alone is not one
//
// Deploys are not instant and the four Workers are not the same size --
// `metagraphed-wss-lb` was at HEAD while the ~1 MB gzip `data-api` was three
// commits back, measured minutes after the same merge. A check that demanded
// `deployed == HEAD` would alarm on every merge for as long as a build takes,
// which is #9301 again.
//
//   FORKED   the deployed SHA is not an ancestor of main. Always wrong: it
//            means a deploy from a branch, or a rollback nobody recorded.
//   STALE    behind, and the OLDEST undeployed commit is older than the grace
//            window. This is the failure the issue is about.
//   LAGGING  behind, but even the oldest undeployed commit is younger than the
//            grace window -- a build in flight, the ordinary state after a merge.
//
// ## The grace window measures the OLDEST undeployed commit, not the newest
//
// It used to measure the build TARGET -- the newest commit that should have
// built -- and that made the check unable to report the thing it exists for.
// A repo with steady merges always has a young newest-commit, so the grace
// window reset on every merge and `stale` required main to go quiet for a full
// thirty minutes. Activity silenced the alarm, which is backwards: a busy repo
// is when a frozen deploy does the most damage.
//
// Measured 2026-08-10 (#10597): `metagraphed` sat SIX commits behind with three
// consecutive failed builds over ~50 minutes, and this check exited 0 --
// "LAGGING, HEAD is 10m old -- inside the 30m grace" -- because someone had
// merged ten minutes earlier. The freeze was found by hand instead.
//
// Asking how long the OLDEST undeployed commit has waited keeps the property
// the grace window was added for (#9301: do not alarm while a build is legitimately
// in flight -- right after a merge the oldest undeployed commit IS the newest one,
// so the verdict is unchanged) while making a stuck build impossible to hide
// behind later merges.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { repoRoot, stripJsonComments } from "./lib.ts";

/**
 * How long a merge may take to reach every Worker before "behind" is a fault.
 *
 * THIRTY MINUTES. Measured 2026-08-10: `wss-lb` reached HEAD ~4 minutes after
 * the merge while `data-api` was still three commits back, and the data-api
 * bundle is ~1 MB gzip against wss-lb's tens of KB. Thirty is several times the
 * slowest observed build, which is the right direction to be wrong in: a bound
 * that alarms during a normal build teaches people to ignore it.
 */
export const DEPLOY_GRACE_MS = 30 * 60 * 1000;

/** Every Worker this repo deploys, by its wrangler config. */
export const WORKER_CONFIGS = [
  "wrangler.jsonc",
  "wrangler.data.jsonc",
  "wrangler.registry.jsonc",
  "wrangler.wss-lb.jsonc",
] as const;

/**
 * The oldest commit still not deployed, from `git rev-list deployed..target`.
 *
 * Exported and pure because THIS is where the bug was, and a test of
 * `judgeDeploy` cannot reach it: the verdict logic was always right, it was
 * being handed the wrong commit. `rev-list` prints newest-first, so the oldest
 * is the LAST line -- taking the first is what let a 58-minute freeze report
 * "10m old, inside the grace" every time somebody merged again (#10597).
 */
export function oldestUndeployedSha(revList: string): string | null {
  const shas = revList.split("\n").filter(Boolean);
  return shas.length ? shas[shas.length - 1] : null;
}

export type DeployVerdict = "ok" | "lagging" | "stale" | "forked" | "unknown";

export interface DeployStatus {
  config: string;
  worker: string;
  deployed: string | null;
  ancestor: boolean;
  behind: number;
  verdict: DeployVerdict;
  detail: string;
}

/**
 * Judge one Worker. Pure, so the verdict table is testable without Cloudflare,
 * git, or a clock.
 */
export function judgeDeploy(input: {
  config: string;
  worker: string;
  deployed: string | null;
  ancestor: boolean;
  behind: number;
  /** How long the OLDEST undeployed commit has been waiting. NOT the newest:
   * see this file's header for the freeze that hid behind later merges. */
  undeployedAgeMs: number;
  graceMs?: number;
  failure?: DeployReadFailure;
}): DeployStatus {
  const { config, worker, deployed, ancestor, behind, undeployedAgeMs } = input;
  const graceMs = input.graceMs ?? DEPLOY_GRACE_MS;
  const base = { config, worker, deployed, ancestor, behind };
  if (!deployed) {
    // Not "everything is fine": we could not read Cloudflare's record, which
    // is a different claim from the Worker being current and must not be
    // reported as one.
    //
    // SAY WHICH KIND OF UNKNOWN. These three have different owners -- a
    // maintainer has to fix the token, nobody can fix a hand-deploy from here,
    // and a transient read is worth ignoring once. Reporting them identically
    // is how an expired credential sits behind a check that looks like it is
    // running (#10357).
    return {
      ...base,
      verdict: "unknown",
      detail:
        input.failure === "auth"
          ? "wrangler could not authenticate -- CLOUDFLARE_API_TOKEN is " +
            "missing, expired, or lacks Workers Scripts read. Only a " +
            "maintainer can change repo secrets or token scope"
          : input.failure === "no-commit-message"
            ? "the live deployment carries no commit SHA in its message, so " +
              "it was not deployed by Workers Builds -- a hand-run " +
              "`wrangler deploy` looks exactly like this"
            : "the deployment record could not be read",
    };
  }
  if (!ancestor) {
    return {
      ...base,
      verdict: "forked",
      detail: `deployed ${deployed.slice(0, 12)} is not an ancestor of main`,
    };
  }
  if (behind === 0) {
    return {
      ...base,
      verdict: "ok",
      detail: "running the newest commit it was asked to build",
    };
  }
  if (undeployedAgeMs < graceMs) {
    return {
      ...base,
      verdict: "lagging",
      detail:
        `${behind} commit(s) behind, oldest undeployed is ` +
        `${Math.round(undeployedAgeMs / 60_000)}m old -- inside the ` +
        `${Math.round(graceMs / 60_000)}m grace`,
    };
  }
  return {
    ...base,
    verdict: "stale",
    detail:
      `${behind} commit(s) behind and the oldest undeployed is ` +
      `${Math.round(undeployedAgeMs / 60_000)}m old -- the build did not land`,
  };
}

/**
 * `name` out of a wrangler JSONC config.
 *
 * Through the SHARED stripper, never a local regex. These configs hold route
 * globs ending in a slash-star and cron expressions containing a star-slash, so
 * a regex stripper splices from one to the next and deletes the config in
 * between -- and it also reads the double slash inside an "https://..." string
 * as a comment. I wrote that regex here first and it failed on the second
 * config, which is the same mistake #10210 removed from the CI scripts.
 *
 * (Naming those delimiters in prose rather than in backticks, because a literal
 * one closes this comment. That happened too.)
 */
export function workerName(config: string): string {
  const raw = readFileSync(path.join(repoRoot, config), "utf8");
  return (
    (JSON.parse(stripJsonComments(raw)) as { name?: string }).name ?? config
  );
}

/**
 * Why a read of Cloudflare's deployment record produced no SHA.
 *
 * "Could not read it" and "read it, it names no commit" are different
 * problems with different owners, and the first draft of this script collapsed
 * both into `null`. That made an expired token report the same verdict as a
 * Worker deployed by hand -- `unknown` either way, with no way to tell which
 * from the job output. The older check this replaced (#5538) got that right and
 * it is the one thing worth carrying over from it.
 */
export type DeployReadFailure = "auth" | "unreadable" | "no-commit-message";

/** An auth failure in wrangler's own words. Matched on stderr rather than an
 * exit code, because `wrangler deployments list` exits 1 for everything. */
const AUTH_PATTERN =
  /not logged in|authentication|unauthori[sz]ed|api token|10000|credential/i;

export function classifyDeployReadError(stderr: string): DeployReadFailure {
  return AUTH_PATTERN.test(stderr) ? "auth" : "unreadable";
}

/**
 * The commit SHA Cloudflare recorded for the live deployment.
 *
 * Workers Builds puts it in the deployment MESSAGE, so this is Cloudflare's own
 * record rather than anything this repo stamps -- which is what lets the check
 * run without a build-time change and without trusting the Worker.
 */
function deployedSha(
  config: string,
): { sha: string } | { failure: DeployReadFailure; stderr: string } {
  let out: string;
  try {
    out = execFileSync(
      "npx",
      ["wrangler", "deployments", "list", "--config", config],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    const stderr = String(
      (error as { stderr?: unknown }).stderr ?? (error as Error).message ?? "",
    );
    return { failure: classifyDeployReadError(stderr), stderr };
  }
  const messages = [...out.matchAll(/^Message:\s+([0-9a-f]{7,40})\s*$/gm)];
  const sha = messages.length ? messages[messages.length - 1]![1] : undefined;
  return sha ? { sha } : { failure: "no-commit-message", stderr: "" };
}

const git = (args: string[]) =>
  execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

/**
 * How far back to look for a commit that built this Worker.
 *
 * Thirty is generous: the longest observed run of commits that rebuild nothing
 * is a handful of scripts/tests/docs merges. Past it the answer is `unknown`
 * rather than a guess -- a Worker whose last build is 30 commits back is either
 * genuinely untouched for a long time or something is wrong with the wiring,
 * and both deserve a look rather than a green tick.
 */
export const BUILD_TARGET_SEARCH_DEPTH = 30;

/**
 * The newest commit on main that actually produced a build for this Worker.
 *
 * NOT `origin/main` HEAD, and this is the correction that matters (#10370).
 * Workers Builds is PATH-FILTERED: a merge touching only `scripts/`, `tests/`
 * or `migrations/` rebuilds nothing, so the deployed SHA legitimately sits
 * behind main -- forever, until something in that Worker's inputs changes.
 * Measured on main:
 *
 *   09517ffa  scripts + tests + migrations  ->  built: wss-lb only
 *   5524f90f  schemas-src                   ->  built: all four
 *
 * Comparing against HEAD therefore reported `stale -- the build did not land`
 * for a Worker that was correctly never asked to build. A watchdog that fires
 * during ordinary operation is the #9301 failure, and this one would have hit
 * it on a large share of merges.
 *
 * The target is read from Cloudflare's OWN decision rather than by
 * reimplementing its path filter: a build leaves a
 * `Workers Builds: <worker>` check run on the commit, so the newest commit
 * carrying one is the newest commit this Worker was supposed to deploy.
 * Duplicating the watch paths here would be a second copy to drift.
 */
export function newestCommitWithBuild(
  worker: string,
  commits: readonly string[],
  checkRunsFor: (sha: string) => readonly string[] | null,
): string | null {
  for (const sha of commits) {
    const names = checkRunsFor(sha);
    // `null` is "could not ask", which is not evidence of "never built" --
    // keep walking rather than let one transient API failure decide.
    if (names === null) continue;
    if (names.includes(`Workers Builds: ${worker}`)) return sha;
  }
  return null;
}

/** The check-run names GitHub records for one commit, or null if unreadable. */
function checkRunNames(sha: string): readonly string[] | null {
  try {
    return execFileSync(
      "gh",
      [
        "api",
        `repos/JSONbored/metagraphed/commits/${sha}/check-runs`,
        "--jq",
        '[.check_runs[].name] | join("\\n")',
      ],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    )
      .split("\n")
      .filter(Boolean);
  } catch {
    return null;
  }
}

export function buildTargetSha(
  worker: string,
  depth = BUILD_TARGET_SEARCH_DEPTH,
): string | null {
  const commits = git([
    "log",
    "--format=%H",
    "-n",
    String(depth),
    "origin/main",
  ])
    .split("\n")
    .filter(Boolean);
  return newestCommitWithBuild(worker, commits, checkRunNames);
}

export function checkWorkerDeploys(nowMs = Date.now()): DeployStatus[] {
  git(["fetch", "origin", "main", "--quiet"]);
  return WORKER_CONFIGS.map((config) => {
    const worker = workerName(config);
    // The commit this Worker was last asked to deploy, falling back to HEAD
    // when no build is visible in the window -- which keeps the old behaviour
    // for a repo state this cannot explain, rather than silently passing.
    const target = buildTargetSha(worker) ?? "origin/main";
    const read = deployedSha(config);
    const deployed = "sha" in read ? read.sha : null;
    let ancestor = false;
    let behind = 0;
    // Falls back to the target's own age, which is what a Worker with nothing
    // undeployed (or an unreadable deployment) should be judged on.
    let undeployedAgeMs =
      nowMs - Number(git(["log", "-1", "--format=%ct", target])) * 1000;
    if (deployed) {
      try {
        git(["merge-base", "--is-ancestor", deployed, "origin/main"]);
        ancestor = true;
        // Counted to the BUILD TARGET, not to HEAD: commits that rebuilt
        // nothing for this Worker are not commits it is behind on.
        const revList = git(["rev-list", `${deployed}..${target}`]);
        behind = revList.split("\n").filter(Boolean).length;
        const oldest = oldestUndeployedSha(revList);
        if (oldest) {
          undeployedAgeMs =
            nowMs - Number(git(["log", "-1", "--format=%ct", oldest])) * 1000;
        }
      } catch {
        ancestor = false;
      }
    }
    return judgeDeploy({
      config,
      worker,
      deployed,
      ancestor,
      behind,
      undeployedAgeMs,
      failure: "failure" in read ? read.failure : undefined,
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = checkWorkerDeploys();
  for (const r of rows) {
    process.stdout.write(
      `${r.verdict.toUpperCase().padEnd(8)} ${r.worker.padEnd(34)} ${r.detail}\n`,
    );
  }
  const bad = rows.filter(
    (r) => r.verdict === "stale" || r.verdict === "forked",
  );
  if (bad.length > 0) {
    process.stderr.write(
      `\n${bad.length} Worker(s) are not running main. Check the Workers ` +
        "Builds log for each: a failed build on a merge commit leaves main " +
        "merged and production on the previous version.\n",
    );
    process.exit(1);
  }
  process.stdout.write("\nEvery Worker is running main, or building it.\n");
}
