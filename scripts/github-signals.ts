// Per-subnet GitHub language + last-push + commit-activity dev-activity
// signal (#6639, #8379, #5968 survey — Bittensor.ai finding). The capture
// logic itself — the four api.github.com REST calls per repo and #8379's
// failure-honesty rules (a failed repo keeps its <30d-old last-good values
// marked `unreachable: true`, or is dropped) — lives in
// src/github-signals-core.ts, SHARED with the Worker cron
// (src/github-signals-sync.ts) that now owns the daily refresh. This script
// is the CLI wrapper around that core: it resolves the repo list from the git
// checkout and maintains the committed seed file.
//
// The daily lane moved to the Worker cron (#233 pattern): the cron captures
// GitHub and writes the R2 store (`generated/github-signals.json`), replacing
// the retired sync-github-signals.yml workflow's regenerate-and-bot-PR loop.
// The committed registry/generated/github-signals.json is demoted to the
// FALLBACK SEED: loadGithubSignals() below reads the R2 store first (publish
// builds carry Cloudflare credentials) and falls back to the committed file,
// whose cold/absent degrade to nulls is unchanged. This script remains the
// way to refresh the seed by hand (`node scripts/github-signals.ts --write`).
//
// #8379 asks for this via GitHub's GraphQL API, batched. It's REST here
// instead, on purpose: GitHub's REST `stats/commit_activity` endpoint already
// returns 52 weeks of commit history pre-bucketed in ONE call — no batching
// scheme needed — and staying REST keeps this pipeline's one HTTP-client
// style consistent rather than introducing a second one for a single field.
//
// A SEPARATE lane from verify-candidates.ts on purpose: that script only ever
// sees NEWLY SUBMITTED candidates (registry/candidates/), so bolting onto its
// cadence would mean already-promoted source-repo surfaces (the vast majority
// of subnets) never get this data, and it would never refresh. This module
// instead resolves the FINAL merged source_repo per subnet (mirroring
// build-artifacts.ts's mergeSubnet / validate.ts's buildExpectedGeneratedSubnet
// exactly: curated overlay wins, else the on-chain chain_identity.github_repo
// backfill), so every subnet with a resolved source-repo gets covered.

import path from "node:path";
import {
  backfilledIdentityUrl,
  buildTimestamp,
  loadNativeSnapshot,
  loadSubnets,
  readJson,
  repoRoot,
  stableStringify,
  writeJson,
} from "./lib.ts";
import {
  captureGithubSignals,
  githubRepoMapKey,
  GITHUB_SIGNALS_R2_KEY,
  parseGithubRepoUrl,
  signalsByKey,
  type CommitWeek,
  type GithubRepoRef,
  type RepoRelease,
  type RepoSignal,
} from "../src/github-signals-core.ts";
import { r2ObjectUrl } from "./r2-rest.ts";

// Re-exported so existing importers (tests, validate.ts) keep one import
// site; the implementations live in the shared core.
export {
  fetchCommitActivity,
  fetchRepoSignals,
  fetchReleases,
  githubRepoMapKey,
  parseGithubRepoUrl,
  type CommitWeek,
  type GithubRepoRef,
  type RepoRelease,
  type RepoSignal,
} from "../src/github-signals-core.ts";

type Row = Record<string, unknown>;

export const githubSignalsPath = path.join(
  repoRoot,
  "registry/generated/github-signals.json",
);

export function githubHeaders(): Record<string, string> {
  if (!process.env.GITHUB_TOKEN) {
    return {};
  }
  return {
    authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    "x-github-api-version": "2022-11-28",
  };
}

export interface GithubSignalEntry {
  languages: Row | null;
  last_push_at: string | null;
  stars: number | null;
  commits_weekly: CommitWeek[] | null;
  /** #8704: null when never captured, [] when the repo publishes none. */
  releases: RepoRelease[] | null;
  unreachable: boolean;
  captured_at: string | null;
}

/**
 * Read the Worker-cron-written R2 store (the #233 lane's primary copy) via
 * Cloudflare's R2 REST API — the same credential pair + object-URL builder the
 * publish scripts already use (scripts/r2-rest.ts). Returns null whenever the
 * store cannot be read AS FRESH TRUTH: credentials absent (local dev, the
 * Validate CI lane — which also keeps tests/artifacts-build-determinism.test.ts
 * network-free), a fetch failure, or a malformed body. Null means the caller
 * falls back to the committed seed, never a hard error — the same tolerant
 * posture every optional registry enrichment here follows.
 */
export async function readGithubSignalsStore(): Promise<Row | null> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    return null;
  }
  try {
    const manifest: Row | null = await readJson(
      path.join(repoRoot, "public/metagraph/r2-manifest.json"),
    ).catch(() => null);
    const bucketName =
      typeof manifest?.bucket_name === "string" && manifest.bucket_name
        ? (manifest.bucket_name as string)
        : "metagraphed-artifacts";
    const response = await fetch(
      r2ObjectUrl(accountId, bucketName, GITHUB_SIGNALS_R2_KEY),
      {
        headers: { authorization: `Bearer ${apiToken}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      return null;
    }
    const doc = (await response.json()) as Row;
    return Array.isArray(doc?.signals) ? doc : null;
  } catch {
    return null;
  }
}

// Loads the signals into a Map keyed by githubRepoMapKey — R2 store first
// (the Worker cron's fresh copy), then the committed seed file.
// Missing/malformed everywhere -> an empty map (never throws) -- a cold/
// not-yet-run signals store degrades every subnet's github_languages/
// github_last_push_at to null, the same schema-stable-empty convention every
// other optional registry enrichment in this codebase follows.
//
// A successful store read is MATERIALIZED into the local seed path (when it
// differs) before being returned. Two callers must agree on the same
// snapshot for artifact parity: the publish build reads the store (it holds
// the credentials), while the publish job's later `npm run validate` step
// runs credential-less against the restored registry/ tree -- the same
// travel-with-the-artifacts design the refreshed native snapshot and
// candidate inputs already use. The local write is what carries the snapshot
// across; it also doubles as the seed-refresh mechanism.
export async function loadGithubSignals(): Promise<
  Map<string, GithubSignalEntry>
> {
  const storeDoc = await readGithubSignalsStore();
  if (storeDoc) {
    const seeded: Row | null = await readJson(githubSignalsPath).catch(
      () => null,
    );
    if (stableStringify(seeded) !== stableStringify(storeDoc)) {
      await writeJson(githubSignalsPath, storeDoc).catch(() => undefined);
    }
  }
  const doc: Row | null =
    storeDoc ?? (await readJson(githubSignalsPath).catch(() => null));
  const entries: Row[] = Array.isArray(doc?.signals)
    ? (doc?.signals as Row[])
    : [];
  return new Map(
    entries
      .filter((entry) => entry?.owner && entry?.repo)
      .map((entry) => [
        githubRepoMapKey(entry.owner as string, entry.repo as string),
        {
          languages:
            entry.languages && typeof entry.languages === "object"
              ? (entry.languages as Row)
              : null,
          last_push_at: (entry.last_push_at as string | undefined) || null,
          stars: typeof entry.stars === "number" ? entry.stars : null,
          commits_weekly: Array.isArray(entry.commits_weekly)
            ? (entry.commits_weekly as CommitWeek[])
            : null,
          // Absent (a signals file written before #8704) reads as null --
          // "not captured" -- not as an empty release list.
          releases: Array.isArray(entry.releases)
            ? (entry.releases as RepoRelease[])
            : null,
          unreachable: entry.unreachable === true,
          captured_at: (entry.captured_at as string | undefined) || null,
        },
      ]),
  );
}

// Resolves one subnet's FINAL source_repo URL (curated overlay wins, else the
// on-chain backfill -- mirrors mergeSubnet/buildExpectedGeneratedSubnet
// exactly) and looks up its captured signals. Returns the schema-stable
// null-valued shape for anything that doesn't resolve to a GitHub repo, or
// that hasn't been captured yet.
export function githubSignalsForSubnet(
  signalsByRepo: Map<string, GithubSignalEntry>,
  overlay: Row | undefined,
  nativeSubnet: Row | undefined,
): Row {
  const sourceRepo = backfilledIdentityUrl(
    overlay?.source_repo,
    (nativeSubnet?.chain_identity as Row | undefined)?.github_repo,
  );
  const parsed = parseGithubRepoUrl(sourceRepo);
  if (!parsed) {
    return {
      github_languages: null,
      github_last_push_at: null,
      github_stars: null,
      github_commits_weekly: null,
      // #8704: null, not [] -- a subnet with no resolvable source repo was
      // never asked, which is not the same as a repo that publishes nothing.
      github_releases: null,
      github_unreachable: false,
    };
  }
  const signals = signalsByRepo.get(
    githubRepoMapKey(parsed.owner, parsed.repo),
  );
  return {
    github_languages: signals?.languages ?? null,
    github_last_push_at: signals?.last_push_at ?? null,
    github_stars: signals?.stars ?? null,
    github_commits_weekly: signals?.commits_weekly ?? null,
    // #8704: feeds the `release` item kind on the per-subnet feed.
    github_releases: signals?.releases ?? null,
    github_unreachable: signals?.unreachable ?? false,
  };
}

// Resolves every subnet's FINAL source_repo the same way mergeSubnet does,
// deduped to one entry per unique GitHub repo (several subnets can share a
// monorepo source_repo). The Worker cron gets the SAME list from the
// published subnets artifact instead (each row's source_repo is this exact
// resolution, baked) — see src/github-signals-sync.ts's header.
async function resolveTrackedRepos(): Promise<GithubRepoRef[]> {
  const [overlays, nativeSnapshot]: [Row[], Row] = await Promise.all([
    loadSubnets(),
    loadNativeSnapshot(),
  ]);
  const overlayByNetuid = new Map(
    overlays.map((overlay) => [overlay.netuid, overlay]),
  );
  const reposByKey = new Map<string, GithubRepoRef>();
  for (const nativeSubnet of (nativeSnapshot.subnets as Row[]) || []) {
    const overlay = overlayByNetuid.get(nativeSubnet.netuid);
    const sourceRepo = backfilledIdentityUrl(
      overlay?.source_repo,
      (nativeSubnet.chain_identity as Row | undefined)?.github_repo,
    );
    const parsed = parseGithubRepoUrl(sourceRepo);
    if (!parsed) continue;
    const key = githubRepoMapKey(parsed.owner, parsed.repo);
    if (!reposByKey.has(key)) {
      reposByKey.set(key, parsed);
    }
  }
  return [...reposByKey.values()];
}

// Keyed the same way the committed artifact's own entries are looked up
// elsewhere (githubRepoMapKey) so a repo's previous capture can be found
// regardless of case drift between runs.
async function loadPreviousSignalsByKey(): Promise<Map<string, RepoSignal>> {
  const doc: Row | null = await readJson(githubSignalsPath).catch(() => null);
  return signalsByKey(doc);
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const shouldWrite = args.has("--write");
  // Tolerant by design (#8379), same convention as this pipeline's other
  // "refresh live external data" steps (refresh-native-snapshot.ts,
  // refresh-candidates.ts): an unexpected failure here (e.g. the resolved
  // repo list can't be loaded) must not block the publish -- it keeps
  // whatever was last committed and the build proceeds with that.
  try {
    const repos = await resolveTrackedRepos();
    const previousByKey = await loadPreviousSignalsByKey();
    // `captured_at`/`generated_at` carry the 1970 build placeholder unless
    // METAGRAPH_BUILD_TIMESTAMP is set, keeping the committed seed's diffs
    // content-only (the convention the retired sync workflow's git-diff gate
    // relied on; the Worker cron's equivalent gate excludes the timestamps
    // from its content digest instead and stamps real times).
    const artifact = await captureGithubSignals(repos, {
      previousByKey,
      headers: githubHeaders(),
      capturedAt: buildTimestamp(),
    });
    if (shouldWrite) {
      await writeJson(githubSignalsPath, artifact);
    }
    console.log(
      stableStringify({
        mode: shouldWrite ? "write" : "dry-run",
        repo_count: artifact.repo_count,
        captured_count: artifact.captured_count,
      }),
    );
  } catch (error) {
    console.warn(
      `::warning::github-signals refresh failed; keeping the last committed signals. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// Only run when invoked directly (`node scripts/github-signals.ts`), not
// when imported for its exported helpers (build-artifacts.ts, validate.ts,
// tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
