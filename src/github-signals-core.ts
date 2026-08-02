// Shared GitHub dev-signal capture core (#6639/#8379/#8704), extracted from
// scripts/github-signals.ts so the CLI seed-refresh script and the Worker cron
// (src/github-signals-sync.ts, the #233 "cron writes the store" lane that
// retired .github/workflows/sync-github-signals.yml) share ONE implementation
// — the capture semantics cannot fork between the two callers.
//
// IO is injected: every fetch goes through an optional `fetchImpl` (defaulting
// to the global fetch so the script's vi.stubGlobal-based tests keep working),
// headers are caller-supplied (the script builds them from process.env, the
// Worker from env.GITHUB_SIGNALS_TOKEN), and the previous artifact arrives as
// a plain Map — this module never touches the filesystem, R2, or process.env.
//
// #8379's failure-honesty rules are preserved exactly: a repo whose metadata
// call fails does not just vanish from the artifact. If a previous successful
// capture exists and is <30d old, its last-good values are retained with
// `unreachable: true`; otherwise the repo is dropped from the artifact
// entirely (never published as `unreachable` forever with no data behind it).

type Row = Record<string, unknown>;

export interface GithubRepoRef {
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

export interface CommitWeek {
  /** ISO date (UTC) of the Sunday that starts this week, matching GitHub's own bucketing. */
  week: string;
  count: number;
}

/**
 * One published release, reduced to what a feed item needs (#8704).
 *
 * `url` is GitHub's own `html_url`, never constructed: `macrocosm-os/prompting`
 * serves releases whose html_url points at `macrocosm-os/apex`, so a URL built
 * from the queried repo name would 404. Same redirect hazard the upgrade radar
 * hit with opentensor/subtensor -> RaoFoundation.
 */
export interface RepoRelease {
  tag: string;
  name: string | null;
  published_at: string;
  url: string;
  prerelease: boolean;
}

export interface RepoSignal {
  owner: string;
  repo: string;
  last_push_at: string | null;
  languages: Row | null;
  stars: number | null;
  commits_weekly: CommitWeek[] | null;
  /**
   * Published releases, newest first. An EMPTY ARRAY is the common case and
   * means "this repo publishes no releases" -- most subnet repos do not use
   * them at all (404-Repo/404-gen-subnet, for one). Null means we could not
   * ask, which is a different thing and is preserved as such.
   */
  releases: RepoRelease[] | null;
  unreachable: boolean;
  captured_at: string | null;
}

/** The whole-artifact shape both writers produce and both readers consume. */
export interface GithubSignalsArtifact {
  schema_version: 1;
  generated_at: string;
  repo_count: number;
  captured_count: number;
  signals: RepoSignal[];
}

/**
 * Literal R2 key for the Worker-cron-written signals store. Lives here (the
 * dependency-free shared module) because BOTH sides of the lane address it:
 * the Worker cron writes it, and the build's loadGithubSignals reads it.
 * Deliberately OUTSIDE the publish pipeline's `latest/` / `runs/` /
 * `by-hash/` trees (same posture as icon-proxy's `icon-cache/` prefix): a
 * publish run must never overwrite, orphan, or atomically-swap this object —
 * it has exactly one writer (the cron) and its lifecycle is independent of
 * the artifact publish.
 */
export const GITHUB_SIGNALS_R2_KEY = "generated/github-signals.json";

/** Injected IO for every GitHub call this module makes. */
export interface GithubFetchOptions {
  headers?: Record<string, string>;
  /** Defaults to the global fetch, resolved at call time. */
  fetchImpl?: typeof fetch;
}

export const COMMIT_WEEKS_SHOWN = 13; // ~90 days
// Enough to cover a busy repo's recent history without paging; the feed caps
// well below this anyway.
export const RELEASES_CAPTURED = 10;
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

async function fetchJson(
  url: string,
  options: GithubFetchOptions,
): Promise<Row> {
  const doFetch = options.fetchImpl ?? fetch;
  const res = await doFetch(url, { headers: options.headers ?? {} });
  if (!res.ok) {
    return { ok: false, status: res.status };
  }
  return { ok: true, body: await res.json() };
}

// The last 52 weeks of commit activity, pre-bucketed by GitHub -- one call,
// no pagination or GraphQL batching needed. GitHub computes these stats
// asynchronously for a repo with no recent cache: a cold cache returns 202
// with an empty array while it builds the cache server-side, which this
// treats the same as "not available yet" (null), not an error -- the next
// day's run picks it up once GitHub finishes computing it.
export async function fetchCommitActivity(
  owner: string,
  repo: string,
  options: GithubFetchOptions = {},
): Promise<CommitWeek[] | null> {
  const res = await fetchJson(
    `https://api.github.com/repos/${owner}/${repo}/stats/commit_activity`,
    options,
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

/**
 * The repo's published releases (#8704).
 *
 * REST, matching this module's own documented rationale for preferring it over
 * GraphQL. Drafts are excluded (unpublished, maintainer-only); prereleases are
 * KEPT and flagged, because for many subnet repos a prerelease is the release.
 *
 * Returns null when GitHub could not be asked, and [] when the repo genuinely
 * publishes nothing — a distinction the caller preserves rather than
 * collapsing, so "no releases" never reads as "capture failed".
 */
export async function fetchReleases(
  owner: string,
  repo: string,
  options: GithubFetchOptions = {},
): Promise<RepoRelease[] | null> {
  const res = await fetchJson(
    `https://api.github.com/repos/${owner}/${repo}/releases?per_page=${RELEASES_CAPTURED}`,
    options,
  );
  if (!res.ok || !Array.isArray(res.body)) return null;
  const releases: RepoRelease[] = [];
  for (const entry of res.body as Row[]) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.draft === true) continue;
    const tag = typeof entry.tag_name === "string" ? entry.tag_name.trim() : "";
    const publishedAt =
      typeof entry.published_at === "string" ? entry.published_at : "";
    const url = typeof entry.html_url === "string" ? entry.html_url : "";
    // A release we cannot date or link cannot become a feed item, so it is
    // not captured either -- storing it would just defer the drop.
    if (!tag || !publishedAt || !url) continue;
    releases.push({
      tag,
      name: typeof entry.name === "string" && entry.name ? entry.name : null,
      published_at: publishedAt,
      url,
      prerelease: entry.prerelease === true,
    });
  }
  return releases;
}

/** Per-entry capture options: the shared IO plus the timestamp to stamp. */
export interface CaptureEntryOptions extends GithubFetchOptions {
  /**
   * Stamped as `captured_at` on a successful capture. The script passes the
   * deterministic build placeholder (content-only diffs against the committed
   * seed); the Worker passes the real tick time so the 30-day last-good
   * retention window actually measures age.
   */
  capturedAt?: string;
}

// One repo's signals: pushed_at + star count from the repo metadata call,
// the full language-by-byte-count breakdown from the dedicated /languages
// endpoint (a SEPARATE call -- the repo metadata response only ever carries
// the single primary `language`, never the full breakdown), the last 13
// weeks of commit activity, and the published releases. A failed/rate-limited
// metadata call degrades to the retained last-good entry (marked unreachable)
// when one exists and is still within the 30-day retention window, or drops
// the repo from this run's output entirely when it doesn't -- never throws,
// so one bad repo can't abort the whole run.
export async function fetchRepoSignals(
  { owner, repo }: GithubRepoRef,
  previousEntry: RepoSignal | undefined,
  options: CaptureEntryOptions = {},
): Promise<RepoSignal | null> {
  const [metaRes, langRes, commitsWeekly, releases] = await Promise.all([
    fetchJson(`https://api.github.com/repos/${owner}/${repo}`, options),
    fetchJson(
      `https://api.github.com/repos/${owner}/${repo}/languages`,
      options,
    ),
    fetchCommitActivity(owner, repo, options),
    fetchReleases(owner, repo, options),
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
    releases,
    unreachable: false,
    captured_at: options.capturedAt ?? new Date().toISOString(),
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

/**
 * Parse a previously-written artifact document into a Map keyed by
 * githubRepoMapKey, so a repo's previous capture can be found regardless of
 * case drift between runs. Missing/malformed input -> an empty map (never
 * throws) -- shared by the script (committed seed) and the Worker (R2 store)
 * so the two read the last-good state identically.
 */
export function signalsByKey(doc: unknown): Map<string, RepoSignal> {
  const entries: Row[] = Array.isArray((doc as Row | null)?.signals)
    ? ((doc as Row).signals as Row[])
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

export interface CaptureArtifactOptions extends CaptureEntryOptions {
  /** Previous artifact entries, for #8379's last-good retention. */
  previousByKey?: Map<string, RepoSignal>;
  /**
   * Concurrent repo captures. 8 matches the script's historical mapLimit; in
   * the Worker runtime, fetches beyond the platform's 6 simultaneous
   * connections queue transparently rather than failing.
   */
  concurrency?: number;
  /** Stamped as the artifact's `generated_at`; defaults to `capturedAt`. */
  generatedAt?: string;
}

/**
 * Capture the full artifact for a resolved repo list — the one shared
 * entry point both writers (script and Worker cron) call, so the artifact
 * shape and the failure-honesty semantics cannot diverge.
 */
export async function captureGithubSignals(
  repos: GithubRepoRef[],
  options: CaptureArtifactOptions = {},
): Promise<GithubSignalsArtifact> {
  const previousByKey = options.previousByKey ?? new Map<string, RepoSignal>();
  const capturedAt = options.capturedAt ?? new Date().toISOString();
  const signals = await mapLimit(repos, options.concurrency ?? 8, (ref) =>
    fetchRepoSignals(
      ref,
      previousByKey.get(githubRepoMapKey(ref.owner, ref.repo)),
      {
        headers: options.headers,
        fetchImpl: options.fetchImpl,
        capturedAt,
      },
    ),
  );
  return {
    schema_version: 1,
    generated_at: options.generatedAt ?? capturedAt,
    repo_count: repos.length,
    captured_count: signals.length,
    signals,
  };
}

// Key-sorted stringify, so the digest is insensitive to property order.
// Same local-copy convention as subnet-identity-history.ts's own
// stableStringify -- tiny, and keeping this module dependency-free matters
// more than deduping ~10 lines.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Row;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

/**
 * Content identity of an artifact, with the volatile timestamps
 * (`generated_at`, per-entry `captured_at`) excluded — the Worker cron's
 * write-only-when-changed gate, equivalent to the retired workflow's git-diff
 * gate (where the script's 1970 `captured_at` placeholder kept diffs
 * content-only). Excluding the timestamps here instead lets the Worker stamp
 * REAL capture times (so the 30-day retention window works) while a run that
 * found identical data still skips the write.
 */
export function githubSignalsContentDigest(
  artifact: GithubSignalsArtifact,
): string {
  return stableStringify({
    ...artifact,
    generated_at: null,
    signals: artifact.signals.map((signal) => ({
      ...signal,
      captured_at: null,
    })),
  });
}
