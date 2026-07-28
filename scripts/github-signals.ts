// Per-subnet GitHub language + last-push + commit-activity dev-activity
// signal (#6639, #8379, #5968 survey — Bittensor.ai finding). Reuses the same
// api.github.com REST calls verify-candidates.ts already makes for
// source-repo verification (owner/repo parsing, GITHUB_TOKEN auth), but
// captures developer-signal metadata (language breakdown, last push, star
// count, 90-day weekly commit history) instead of existence/redirect
// verification.
//
// #8379 asks for this via GitHub's GraphQL API, batched. It's REST here
// instead, on purpose: GitHub's REST `stats/commit_activity` endpoint already
// returns 52 weeks of commit history pre-bucketed in ONE call — no batching
// scheme needed — and staying REST keeps this script's one HTTP-client style
// consistent rather than introducing a second one for a single field.
//
// A SEPARATE periodic pass from verify-candidates.ts on purpose: that script
// only ever sees NEWLY SUBMITTED candidates (registry/candidates/), so bolting
// onto its cadence would mean already-promoted source-repo surfaces (the vast
// majority of subnets) never get this data, and it would never refresh. This
// module instead resolves the FINAL merged source_repo per subnet (mirroring
// build-artifacts.ts's mergeSubnet / validate.ts's buildExpectedGeneratedSubnet
// exactly: curated overlay wins, else the on-chain chain_identity.github_repo
// backfill), so every subnet with a resolved source-repo gets covered --
// matching the registry-build cadence, not the candidate-discovery one.
//
// Output is a committed JSON file (registry/generated/github-signals.json),
// same "periodically maintainer-run, git-committed" shape as
// registry/verification/promotions.json -- machine-derived, not
// community-editable (mirrors how `categories`/`verification` work). #8379
// wires this into publish-cloudflare.yml's `refresh` job (a token is already
// available there), so "periodically maintainer-run" becomes "run once daily
// by the publish workflow" without changing the committed-artifact shape.
//
// #8379's failure-honesty requirement: a repo whose metadata call fails
// doesn't just vanish from the artifact anymore. If a previous successful
// capture exists and is <30d old, its last-good values are retained with
// `unreachable: true`; otherwise the repo is dropped from the artifact
// entirely (never published as `unreachable` forever with no data behind it).

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

type Row = Record<string, unknown>;

export const githubSignalsPath = path.join(
  repoRoot,
  "registry/generated/github-signals.json",
);

interface GithubRepoRef {
  owner: string;
  repo: string;
}

// Parses a github.com repo URL into {owner, repo}, or null for anything else
// (a non-GitHub source-repo, or a malformed URL). Mirrors verify-candidates.ts's
// own parseGithubRepo -- kept as a separate copy rather than a shared import
// since that module's version is tied to its own candidate-verification
// call shape, not exported for reuse.
export function parseGithubRepoUrl(value: unknown): GithubRepoRef | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  try {
    const url = new URL(value);
    if (url.hostname !== "github.com") {
      return null;
    }
    const [owner, repo] = url.pathname.split("/").filter(Boolean);
    if (!owner || !repo) {
      return null;
    }
    return { owner, repo: repo.replace(/\.git$/, "") };
  } catch {
    return null;
  }
}

// "owner/repo" (lowercased -- GitHub repo paths are case-insensitive for
// routing purposes, confirmed live: github.com/Owner/Repo and
// github.com/owner/repo resolve to the same repository) as the signals map
// key, so a subnet's resolved source_repo URL can be looked up regardless of
// the exact casing either side happened to use.
export function githubRepoMapKey(owner: string, repo: string): string {
  return `${owner}/${repo}`.toLowerCase();
}

export function githubHeaders(): Record<string, string> {
  if (!process.env.GITHUB_TOKEN) {
    return {};
  }
  return {
    authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    "x-github-api-version": "2022-11-28",
  };
}

export interface CommitWeek {
  /** ISO date (UTC) of the Sunday that starts this week, matching GitHub's own bucketing. */
  week: string;
  count: number;
}

export interface GithubSignalEntry {
  languages: Row | null;
  last_push_at: string | null;
  stars: number | null;
  commits_weekly: CommitWeek[] | null;
  unreachable: boolean;
  captured_at: string | null;
}

// Loads the committed signals file into a Map keyed by githubRepoMapKey.
// Missing/malformed file -> an empty map (never throws) -- a cold/not-yet-run
// signals file degrades every subnet's github_languages/github_last_push_at
// to null, the same schema-stable-empty convention every other optional
// registry enrichment in this codebase follows.
export async function loadGithubSignals(): Promise<
  Map<string, GithubSignalEntry>
> {
  const doc: Row | null = await readJson(githubSignalsPath).catch(() => null);
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
    github_unreachable: signals?.unreachable ?? false,
  };
}

// Resolves every subnet's FINAL source_repo the same way mergeSubnet does,
// deduped to one entry per unique GitHub repo (several subnets can share a
// monorepo source_repo) -- mirrors the exact dedup verify-candidates.ts's
// own mapLimit concurrency needs, just keyed on repo identity instead of
// candidate id.
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

async function fetchJson(url: string): Promise<Row> {
  const res = await fetch(url, { headers: githubHeaders() });
  if (!res.ok) {
    return { ok: false, status: res.status };
  }
  return { ok: true, body: await res.json() };
}

export interface RepoSignal {
  owner: string;
  repo: string;
  last_push_at: string | null;
  languages: Row | null;
  stars: number | null;
  commits_weekly: CommitWeek[] | null;
  unreachable: boolean;
  captured_at: string | null;
}

const COMMIT_WEEKS_SHOWN = 13; // ~90 days
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// The last 52 weeks of commit activity, pre-bucketed by GitHub -- one call,
// no pagination or GraphQL batching needed. GitHub computes these stats
// asynchronously for a repo with no recent cache: a cold cache returns 202
// with an empty array while it builds the cache server-side, which this
// treats the same as "not available yet" (null), not an error -- the next
// day's run picks it up once GitHub finishes computing it.
export async function fetchCommitActivity(
  owner: string,
  repo: string,
): Promise<CommitWeek[] | null> {
  const res = await fetchJson(
    `https://api.github.com/repos/${owner}/${repo}/stats/commit_activity`,
  );
  if (!res.ok || !Array.isArray(res.body)) {
    return null;
  }
  const weeks = res.body as Row[];
  if (weeks.length === 0) {
    return null;
  }
  return weeks.slice(-COMMIT_WEEKS_SHOWN).map((w) => ({
    week: new Date((w.week as number) * 1000).toISOString(),
    count: (w.total as number | undefined) ?? 0,
  }));
}

// One repo's signals: pushed_at + star count from the repo metadata call,
// the full language-by-byte-count breakdown from the dedicated /languages
// endpoint (a SEPARATE call -- the repo metadata response only ever carries
// the single primary `language`, never the full breakdown), and the last 13
// weeks of commit activity. A failed/rate-limited metadata call degrades to
// the retained last-good entry (marked unreachable) when one exists and is
// still within the 30-day retention window, or drops the repo from this run's
// output entirely when it doesn't -- never throws, so one bad repo can't
// abort the whole run.
export async function fetchRepoSignals(
  { owner, repo }: GithubRepoRef,
  previousEntry: RepoSignal | undefined,
): Promise<RepoSignal | null> {
  const [metaRes, langRes, commitsWeekly] = await Promise.all([
    fetchJson(`https://api.github.com/repos/${owner}/${repo}`),
    fetchJson(`https://api.github.com/repos/${owner}/${repo}/languages`),
    fetchCommitActivity(owner, repo),
  ]);
  if (!metaRes.ok) {
    if (
      previousEntry &&
      previousEntry.captured_at &&
      Date.now() - Date.parse(previousEntry.captured_at) <= RETENTION_MS
    ) {
      return { ...previousEntry, owner, repo, unreachable: true };
    }
    return null;
  }
  const metaBody = metaRes.body as Row;
  return {
    owner,
    repo,
    last_push_at: (metaBody.pushed_at as string | undefined) || null,
    languages: langRes.ok ? (langRes.body as Row) : null,
    stars: (metaBody.stargazers_count as number | undefined) ?? null,
    commits_weekly: commitsWeekly,
    unreachable: false,
    captured_at: buildTimestamp(),
  };
}

async function mapLimit<T, R extends { owner: string; repo: string }>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R | null>,
): Promise<R[]> {
  const queue = [...items];
  const results: R[] = [];
  const workers = Array.from(
    { length: Math.min(limit, queue.length) },
    async () => {
      while (queue.length > 0) {
        const item = queue.shift() as T;
        const result = await mapper(item);
        if (result) results.push(result);
      }
    },
  );
  await Promise.all(workers);
  return results.sort(
    (a, b) => a.owner.localeCompare(b.owner) || a.repo.localeCompare(b.repo),
  );
}

// Keyed the same way the committed artifact's own entries are looked up
// elsewhere (githubRepoMapKey) so a repo's previous capture can be found
// regardless of case drift between runs.
async function loadPreviousSignalsByKey(): Promise<Map<string, RepoSignal>> {
  const doc: Row | null = await readJson(githubSignalsPath).catch(() => null);
  const entries: Row[] = Array.isArray(doc?.signals)
    ? (doc?.signals as Row[])
    : [];
  return new Map(
    entries
      .filter((e) => e?.owner && e?.repo)
      .map((e) => [
        githubRepoMapKey(e.owner as string, e.repo as string),
        e as unknown as RepoSignal,
      ]),
  );
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
    const signals = await mapLimit(repos, 8, (ref) =>
      fetchRepoSignals(
        ref,
        previousByKey.get(githubRepoMapKey(ref.owner, ref.repo)),
      ),
    );
    const artifact = {
      schema_version: 1,
      generated_at: buildTimestamp(),
      repo_count: repos.length,
      captured_count: signals.length,
      signals,
    };
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
