// Daily github-signals capture as a Worker cron writing R2 (#233 pattern) —
// the first retirement of a PR-based sync lane.
//
// Provenance: this replaces .github/workflows/sync-github-signals.yml (daily
// 06:20 UTC), which ran `node scripts/github-signals.ts --write` and opened an
// auto-merged bot PR whenever registry/generated/github-signals.json drifted.
// That lane's failure mode was SILENT STALENESS: any workflow misfire left the
// committed file frozen, and a stale capture suppressed release feed items and
// weekly digests with no alarm anywhere. Here the cron writes the artifact
// straight to the R2 store the artifact build reads (scripts/github-signals.ts
// `loadGithubSignals()` tries the store first, committed file as fallback
// seed), so freshness no longer depends on a bot PR landing.
//
// Repo-list source: the PUBLISHED /metagraph/subnets.json artifact, read
// through the same internal readArtifact path other crons use (it is an
// R2-preferred dual artifact, so this serves the freshest published copy).
// Each row's `source_repo` IS mergeSubnet's resolution — curated overlay wins,
// else the on-chain chain_identity.github_repo backfill (see
// backfilledIdentityUrl in scripts/lib.ts) — i.e. exactly the resolution the
// script's own resolveTrackedRepos computes from the git checkout, minus the
// checkout. Deduped by owner/repo since several subnets share a monorepo.
//
// Subrequest budget: ~119 tracked repos x 4 GitHub calls ≈ 476, plus the
// subnets read, the previous-artifact read, the conditional write, and
// telemetry — comfortably under the 1000-subrequests-per-invocation platform
// ceiling. GITHUB_SIGNALS_MAX_REPOS_PER_RUN caps a grown registry at 230
// repos/run (920 GitHub calls) to stay under it; past the cap the repo set is
// split deterministically across alternate days (repo-key hash parity vs
// day-of-month parity), so every repo is still captured at least every other
// day.

import type { StorageReadResult } from "../workers/storage.ts";
import {
  captureGithubSignals,
  githubSignalsContentDigest,
  githubRepoMapKey,
  parseGithubRepoUrl,
  signalsByKey,
  GITHUB_SIGNALS_R2_KEY,
  type GithubRepoRef,
  type GithubSignalsArtifact,
} from "./github-signals-core.ts";
import { recordExceptionEvent } from "./usage-telemetry.ts";

type Row = Record<string, unknown>;

// The store key both sides of the lane address — see its definition in
// github-signals-core.ts for the key-placement rationale. Re-exported so the
// cron's callers/tests can keep importing it from the sync module.
export { GITHUB_SIGNALS_R2_KEY };

/** The published subnets artifact the repo list is resolved from. */
export const GITHUB_SIGNALS_SUBNETS_ARTIFACT_PATH = "/metagraph/subnets.json";

/**
 * Defensive per-run repo ceiling: 230 repos x 4 calls = 920 GitHub
 * subrequests, leaving headroom under the 1000/invocation platform limit for
 * the R2/KV reads, the write, and telemetry.
 */
export const GITHUB_SIGNALS_MAX_REPOS_PER_RUN = 230;

export interface GithubSignalsSyncDeps {
  readArtifact?: (env: Env, path: string) => Promise<StorageReadResult>;
  fetchImpl?: typeof fetch;
  /** Clock seam for tests; stamps captured_at/generated_at and picks the split day. */
  now?: () => number;
  /** Telemetry seam for tests; defaults to the real recordExceptionEvent. */
  recordException?: typeof recordExceptionEvent;
}

interface Ctx {
  waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * GitHub request headers for the cron's capture. Mirrors
 * src/upgrade-radar.ts's githubHeaders (GitHub rejects requests with no
 * user-agent; the API version pin keeps payload shapes stable), but takes the
 * already-validated token — the caller enforces the no-token no-op, so this
 * never builds unauthenticated headers.
 */
export function githubSignalsHeaders(token: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    "user-agent": "metagraphed-github-signals-sync",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${token}`,
  };
}

// Tiny deterministic string hash for the alternate-day split — stability
// across runs is all that matters, not distribution quality.
function repoKeyHash(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/**
 * The subset of tracked repos this run captures. At or under the ceiling the
 * whole list runs daily (the steady state today, ~119 repos). Over it, the
 * set is split by repo-key hash parity matched against day-of-month parity —
 * simple, deterministic, and each half stays within the subrequest budget —
 * then hard-capped as the last-resort bound.
 */
export function reposForRun(
  repos: GithubRepoRef[],
  dayOfMonth: number,
): GithubRepoRef[] {
  if (repos.length <= GITHUB_SIGNALS_MAX_REPOS_PER_RUN) {
    return repos;
  }
  const parity = dayOfMonth % 2;
  return repos
    .filter(
      (ref) =>
        repoKeyHash(githubRepoMapKey(ref.owner, ref.repo)) % 2 === parity,
    )
    .slice(0, GITHUB_SIGNALS_MAX_REPOS_PER_RUN);
}

/**
 * Resolve the deduped tracked-repo list from the published subnets artifact's
 * rows — each row's `source_repo` is already mergeSubnet's final resolution
 * (see the module header), so this only parses and dedupes.
 */
export function trackedReposFromSubnets(rows: unknown): GithubRepoRef[] {
  const reposByKey = new Map<string, GithubRepoRef>();
  for (const row of Array.isArray(rows) ? (rows as Row[]) : []) {
    const parsed = parseGithubRepoUrl(row?.source_repo);
    if (!parsed) continue;
    const key = githubRepoMapKey(parsed.owner, parsed.repo);
    if (!reposByKey.has(key)) {
      reposByKey.set(key, parsed);
    }
  }
  return [...reposByKey.values()];
}

export interface GithubSignalsSyncResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  changed?: boolean;
  repo_count?: number;
  captured_count?: number;
}

/**
 * The daily cron tick: resolve repos from the published registry, capture via
 * the shared core (last-good retention intact), and write the R2 store ONLY
 * when the content actually moved (timestamps excluded — the same
 * content-only gate the retired workflow got from git-diff).
 *
 * WITHOUT env.GITHUB_SIGNALS_TOKEN this no-ops LOUDLY — console.error plus
 * one recordExceptionEvent — and never runs unauthenticated: Cloudflare's
 * shared egress IPs burn through GitHub's 60/hr anonymous budget instantly,
 * which would mass-`unreachable` the artifact. Publishing that would be the
 * exact silent-staleness failure this lane exists to end, so refusing to run
 * (visibly) is the correct degraded mode.
 */
export async function runGithubSignalsSync(
  env: Env,
  ctx?: Ctx,
  deps: GithubSignalsSyncDeps = {},
): Promise<GithubSignalsSyncResult> {
  const token =
    typeof env.GITHUB_SIGNALS_TOKEN === "string"
      ? env.GITHUB_SIGNALS_TOKEN.trim()
      : "";
  if (!token) {
    console.error(
      "[github-signals-sync] GITHUB_SIGNALS_TOKEN is not configured; " +
        "skipping the capture entirely (an unauthenticated run would " +
        "mass-unreachable the artifact). Set it with " +
        "`wrangler secret put GITHUB_SIGNALS_TOKEN`.",
    );
    const pending = Promise.resolve(
      (deps.recordException ?? recordExceptionEvent)(env, {
        error: new Error("GITHUB_SIGNALS_TOKEN not configured"),
        route: "cron:github-signals-sync",
        errorCode: "github_signals_token_missing",
      }),
    ).catch(() => false);
    ctx?.waitUntil?.(pending);
    return {
      ok: false,
      skipped: true,
      reason: "GITHUB_SIGNALS_TOKEN not configured",
    };
  }
  if (typeof deps.readArtifact !== "function") {
    return { ok: false, reason: "reader_unavailable" };
  }
  const bucket = env.METAGRAPH_ARCHIVE;
  if (!bucket?.get || !bucket?.put) {
    return { ok: false, reason: "r2_binding_missing" };
  }
  try {
    const subnetsRead = await deps.readArtifact(
      env,
      GITHUB_SIGNALS_SUBNETS_ARTIFACT_PATH,
    );
    if (!subnetsRead?.ok) {
      return { ok: false, reason: "subnets_artifact_unavailable" };
    }
    const allRepos = trackedReposFromSubnets(
      (subnetsRead.data as { subnets?: unknown } | null)?.subnets,
    );
    if (allRepos.length === 0) {
      // An artifact with zero resolvable source repos is a broken input, not
      // an empty registry — never let it wipe the store.
      return { ok: false, reason: "no_tracked_repos" };
    }
    const now = deps.now ?? Date.now;
    const tickAt = new Date(now());
    const repos = reposForRun(allRepos, tickAt.getUTCDate());

    let previousDoc: unknown = null;
    try {
      const object = await bucket.get(GITHUB_SIGNALS_R2_KEY);
      previousDoc = object ? await object.json() : null;
    } catch {
      // A cold or unreadable previous store degrades to "no retention
      // credit", the same as the lane's very first run.
      previousDoc = null;
    }
    const previousByKey = signalsByKey(previousDoc);

    const artifact = await captureGithubSignals(repos, {
      previousByKey,
      headers: githubSignalsHeaders(token),
      fetchImpl: deps.fetchImpl,
      capturedAt: tickAt.toISOString(),
    });

    if (artifact.captured_count === 0 && previousByKey.size > 0) {
      // Total capture failure with retention exhausted: keep the last-good
      // store rather than overwriting it with an empty artifact. The retired
      // workflow's equivalent was a human eyeballing the count drop in the
      // bot-PR title before merging.
      return {
        ok: false,
        reason: "empty_capture",
        repo_count: artifact.repo_count,
        captured_count: 0,
      };
    }

    const previousDigest = Array.isArray((previousDoc as Row | null)?.signals)
      ? githubSignalsContentDigest(previousDoc as GithubSignalsArtifact)
      : null;
    if (previousDigest === githubSignalsContentDigest(artifact)) {
      return {
        ok: true,
        changed: false,
        repo_count: artifact.repo_count,
        captured_count: artifact.captured_count,
      };
    }

    await bucket.put(GITHUB_SIGNALS_R2_KEY, JSON.stringify(artifact), {
      httpMetadata: { contentType: "application/json" },
    });
    return {
      ok: true,
      changed: true,
      repo_count: artifact.repo_count,
      captured_count: artifact.captured_count,
    };
  } catch (error) {
    // One failed tick is one stale day, not an outage — contained, but never
    // silent (handleScheduled records the ok:false cron outcome too).
    console.error("[github-signals-sync]", String((error as Error)?.message));
    return { ok: false, reason: "unreachable" };
  }
}
