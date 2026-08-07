// Link-rot checking for the three URL populations the health prober does not
// cover (#9907, #9914, #9917).
//
// WHY THIS IS NOT THE HEALTH PROBER. `OPERATIONAL_SURFACE_KINDS` deliberately
// limits the prober to subtensor-rpc/wss, archive, subnet-api, sse and
// data-artifact -- things with uptime. The URLs here are references: a README
// that proves a subnet publishes an API, a provider's website, a docs page. They
// have no uptime, they must never enter incidents or the pool breaker, and
// checking them every 15 minutes would be 1,067 pointless requests an hour.
// They rot on a scale of weeks, so they are checked once a day.
//
// The populations overlap heavily -- 777 source_urls + 384 provider URLs + 494
// non-operational surface URLs is only 1,067 DISTINCT urls -- so everything here
// is keyed by URL, and citations fan back out to whoever referenced it.
//
// Subrequest budget: a Worker invocation may make 1000 subrequests.
//
// 102 of the URLs are metagraph.sh/logos/* — OUR OWN static assets. Those are
// checked against the files on disk by a build gate: free, deterministic, and
// it attributes a missing logo to the commit that dropped it instead of to a
// 3am fetch. That leaves 965 network checks.
//
// Reusing github-signals for the 165 github.com repo roots was considered and
// REJECTED: that lane DROPS a gone repo from its artifact (#9969) rather than
// flagging it, so absence there conflates "gone" with "never tracked" and "the
// capture was rate-limited". Deriving death from absence is the exact error
// #9969 existed to fix. All 429 github.com URLs go through the GitHub API
// instead, which answers the question directly.
//
// 965 exceeds LINK_STATUS_MAX_CHECKS_PER_RUN on purpose: the per-run cap picks
// the least-recently-checked first, so every URL is still covered every ~2 days
// and the invocation keeps headroom under the platform ceiling.

import {
  classifyProbe,
  mapLimit,
  probeUrl,
  type ProbeSurface,
} from "./health-probe-core.ts";

type Row = Record<string, unknown>;

/** R2 key for the capture store, alongside the other control-plane stores. */
export const LINK_STATUS_R2_KEY = "control/link-status.json";

/**
 * Consecutive daily failures before a link is called dead.
 *
 * One bad night is not rot. Three consecutive daily runs means a link has been
 * unreachable for ~72 hours across three independent resolver/network samples,
 * which is past any plausible deploy blip or maintenance window. Only
 * UNREACHABLE_CLASSIFICATIONS increment the counter, and any reachable verdict
 * resets it to zero -- so a link must fail three times IN A ROW, not three
 * times ever.
 */
export const LINK_DEAD_STRIKES = 3;

/** Per-host serialization is the default; GitHub's API is exempt (see below). */
export const LINK_CHECK_CONCURRENCY = 8;

/**
 * Defensive per-run ceiling, mirroring GITHUB_SIGNALS_MAX_REPOS_PER_RUN.
 *
 * The measured population is 965 network-checkable URLs; 900 keeps ~100
 * subrequests of headroom under the 1000-per-invocation platform limit for the
 * two artifact reads, the two store reads, the write and telemetry. The 65-URL
 * remainder is not dropped — urlsForRun orders by least-recently-checked, so
 * the tail rotates in on the following tick and every URL is covered within
 * about two days.
 */
export const LINK_STATUS_MAX_CHECKS_PER_RUN = 900;

/** Per-URL request budget. Reference links are not latency-sensitive. */
export const LINK_CHECK_TIMEOUT_MS = 8000;

/**
 * Classifications meaning the link DID NOT SERVE THE DOCUMENT, and so accrue a
 * strike. A strike is not a verdict — LINK_DEAD_STRIKES consecutive ones are.
 *
 *   - `dead`        — an explicit 404/410.
 *   - `unsupported` — the fetch never completed: NXDOMAIN, connection refused,
 *                     TLS failure. For a plain GET of a static reference URL
 *                     there is no benign reading of that.
 *   - `transient`   — a 5xx. Included *because* of the streak rule, not despite
 *                     it: the largest single rot cluster in the registry is
 *                     api.eirel.ai, which serves Cloudflare 521 (origin down)
 *                     behind live DNS for 121 surfaces. One 521 is transient;
 *                     three days of them is a dead origin, and excluding 5xx
 *                     outright would make the lane blind to its biggest case.
 *   - `timeout`     — same argument. Three consecutive days of timeouts is not
 *                     a slow day.
 *
 * Deliberately EXCLUDED, because each proves the host is alive and serving:
 * `auth-required` (401/403 — Cloudflare bot protection answers 403 for
 * perfectly live docs, and this was a real false-positive source in the audit),
 * `rate-limited` (429 — we asked too often), `redirected`, `content-mismatch`,
 * `live`. `unsafe` is excluded too: that is a verdict about our own guard, not
 * about the target.
 */
export const UNREACHABLE_CLASSIFICATIONS = new Set([
  "dead",
  "unsupported",
  "transient",
  "timeout",
]);

export type LinkCitationKind = "source_url" | "surface" | "provider";

export interface LinkCitation {
  kind: LinkCitationKind;
  /** Surface id, provider slug, or the surface whose source_urls cite it. */
  id: string;
  netuid?: number;
}

export interface LinkTarget {
  url: string;
  citations: LinkCitation[];
}

/**
 * How a given URL is checked. Splitting this out keeps the routing decision
 * pure and testable, and keeps the budget arithmetic above honest.
 */
export type LinkCheckStrategy = "http" | "github-api" | "self";

export interface LinkStatusRecord {
  url: string;
  /** healthClassification vocabulary (src/contracts.ts) — shared with the prober. */
  classification: string;
  status_code: number | null;
  checked_at: string;
  last_ok: string | null;
  /** Consecutive UNREACHABLE_CLASSIFICATIONS results. Reset to 0 by any other verdict. */
  consecutive_failures: number;
  error: string | null;
}

export interface LinkStatusArtifact {
  schema_version: 1;
  generated_at: string;
  checked_count: number;
  /** Links at or past LINK_DEAD_STRIKES. */
  dead_count: number;
  links: LinkStatusRecord[];
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * No try/catch: every caller reaches this only after `hostOf` returned
 * "github.com", which an unparseable URL can never produce. A defensive catch
 * here would be an unreachable branch — dead code that still has to be counted.
 */
function pathSegments(url: string): string[] {
  return new URL(url).pathname.split("/").filter(Boolean);
}

/** Our own published origin — verified against the repo, never over the network. */
export function isSelfHostedUrl(url: string): boolean {
  return hostOf(url) === "metagraph.sh";
}

export function linkCheckStrategy(url: string): LinkCheckStrategy {
  if (isSelfHostedUrl(url)) return "self";
  if (hostOf(url) !== "github.com") return "http";
  // Needs at least /owner/repo to be answerable by the API; anything shorter
  // (/orgs/x, /features) is an ordinary web page.
  return pathSegments(url).length >= 2 ? "github-api" : "http";
}

/**
 * Rewrite a github.com URL to the equivalent REST API URL.
 *
 * Checked through the API rather than by fetching the HTML page for three
 * reasons: github.com serves a soft-404 HTML page that a status-code check
 * reads as 200; the API answers a clean 404 for a deleted repo or a moved file;
 * and the token the github-signals lane already holds lifts the rate limit from
 * 60/hr to 5000/hr, which is what makes 429 checks in one run safe.
 *
 *   /owner/repo                        -> /repos/owner/repo
 *   /owner/repo/blob|tree/<ref>/<path> -> /repos/owner/repo/contents/<path>?ref=<ref>
 *
 * Returns null when the URL is not a github.com URL with an owner and repo.
 */
export function githubApiUrl(url: string): string | null {
  if (linkCheckStrategy(url) !== "github-api") return null;
  const segments = pathSegments(url);
  const [owner, repo, kind, ref, ...rest] = segments;
  if (rest.length > 0 && ["blob", "tree"].includes(kind)) {
    // pathSegments comes from URL.pathname, which is ALREADY percent-encoded.
    // Encoding again turned "my file.md" into "my%2520file.md" and would have
    // reported a false 404 for every path containing a space or non-ASCII
    // character.
    const filePath = rest.join("/");
    const api = new URL(
      `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
    );
    api.searchParams.set("ref", ref);
    return api.toString();
  }
  // Repo root, or any other sub-page (/issues, /releases): the repo's own
  // existence is the question those all depend on.
  return `https://api.github.com/repos/${owner}/${repo}`;
}

/** Provider fields that hold a public URL we assert resolves. */
export const PROVIDER_URL_FIELDS = [
  "website_url",
  "docs_url",
  "github_url",
  "logo_url",
  "contact_url",
  "status_url",
] as const;

/**
 * Every distinct URL the registry asserts, with who asserts it.
 *
 * Deduped by URL because the three populations overlap: a subnet's source_repo
 * is frequently also its provider's github_url and a source_url on three of its
 * surfaces. One check answers all of them.
 */
export function collectLinkTargets(
  subnets: Row[],
  providers: Row[],
  operationalKinds: ReadonlySet<string>,
): LinkTarget[] {
  const targets = new Map<string, LinkTarget>();
  const add = (url: unknown, citation: LinkCitation) => {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return;
    const existing = targets.get(url);
    if (existing) existing.citations.push(citation);
    else targets.set(url, { url, citations: [citation] });
  };

  for (const subnet of subnets) {
    const netuid = subnet.netuid as number | undefined;
    for (const surface of (subnet.surfaces as Row[]) || []) {
      const id = String(surface.id || "");
      for (const sourceUrl of (surface.source_urls as unknown[]) || []) {
        add(sourceUrl, { kind: "source_url", id, netuid });
      }
      // The surface's own URL, but only for the kinds the prober skips —
      // an operational surface is already checked every 15 minutes.
      if (
        surface.public_safe &&
        (surface.probe as Row | undefined)?.enabled &&
        !operationalKinds.has(String(surface.kind))
      ) {
        add(surface.url, { kind: "surface", id, netuid });
      }
    }
  }

  for (const provider of providers) {
    const slug = String(provider.slug || "");
    for (const field of PROVIDER_URL_FIELDS) {
      add(provider[field], { kind: "provider", id: slug });
    }
  }

  return [...targets.values()].sort((a, b) => a.url.localeCompare(b.url));
}

/**
 * Fold one check result into the running record, applying the strike rule.
 *
 * `prior` absent means this URL has never been checked: it starts at zero
 * strikes even if this first check fails, so a link added today cannot be
 * called dead until it has failed LINK_DEAD_STRIKES separate runs.
 */
export function nextLinkRecord(
  prior: LinkStatusRecord | undefined,
  result: {
    url: string;
    classification: string;
    status_code: number | null;
    error: string | null;
  },
  checkedAt: string,
): LinkStatusRecord {
  const unreachable = UNREACHABLE_CLASSIFICATIONS.has(result.classification);
  return {
    url: result.url,
    classification: result.classification,
    status_code: result.status_code,
    checked_at: checkedAt,
    last_ok: unreachable ? prior?.last_ok || null : checkedAt,
    consecutive_failures: unreachable
      ? (prior?.consecutive_failures || 0) + 1
      : 0,
    error: result.error,
  };
}

/**
 * Has this link failed often enough, consecutively, to be called dead?
 *
 * The single place the strike threshold is applied, so the artifact projection,
 * the demotion path and the CI gate cannot disagree about what "dead" means.
 */
export function isConfirmedDeadLink(
  record: LinkStatusRecord | undefined,
): boolean {
  return (record?.consecutive_failures || 0) >= LINK_DEAD_STRIKES;
}

export interface CheckLinkDeps {
  fetchImpl?: typeof fetch;
  /** `unknown` to match probeUrl's own guard signature exactly. */
  isUnsafeUrl?: (url: unknown) => boolean | Promise<boolean>;
  /** Authorization header value for api.github.com, when a token is configured. */
  githubAuth?: string | null;
}

/**
 * Check one URL and classify it in the prober's own vocabulary.
 *
 * Reuses probeUrl + classifyProbe rather than reimplementing status handling.
 * That is not just economy: a hand-rolled checker is exactly what produced 25
 * false "broken" verdicts in the audit that led to these issues, because it did
 * not know that 403 means Cloudflare and 429 means slow down.
 *
 * HEAD first (a reference link's body is never needed), falling back to GET on
 * 405/501 — plenty of static hosts reject HEAD outright.
 */
export async function checkLink(
  url: string,
  deps: CheckLinkDeps = {},
): Promise<{
  url: string;
  classification: string;
  status_code: number | null;
  error: string | null;
}> {
  // Non-null exactly for the github-api strategy, so this one value carries
  // both decisions: which URL to ask, and whether the token applies. Deriving
  // them separately from `strategy` left a `githubApiUrl(url) || url` fallback
  // that could never be taken.
  const apiUrl = githubApiUrl(url);
  const requestUrl = apiUrl ?? url;
  const auth = apiUrl ? deps.githubAuth : null;

  const options = {
    fetchImpl: auth
      ? withHeaders(deps.fetchImpl ?? fetch, { authorization: auth })
      : deps.fetchImpl,
    isUnsafeUrl: deps.isUnsafeUrl,
  };

  let probe = await probeUrl(
    requestUrl,
    "HEAD",
    "*/*",
    LINK_CHECK_TIMEOUT_MS,
    options,
  );
  if (probe.status_code === 405 || probe.status_code === 501) {
    probe = await probeUrl(
      requestUrl,
      "GET",
      "*/*",
      LINK_CHECK_TIMEOUT_MS,
      options,
    );
  }

  // `expect: "any"` so contentMismatch never fires — a reference link makes no
  // promise about its content type, only that it resolves.
  const asSurface: ProbeSurface = {
    id: url,
    kind: "docs",
    url: requestUrl,
    netuid: null,
    provider: null,
    public_safe: true,
    auth_required: false,
    subnet_name: null,
    subnet_slug: null,
    probe: { method: "HEAD", expect: "any" },
  };

  return {
    url,
    classification: classifyProbe(probe, asSurface),
    status_code: probe.status_code ?? null,
    error: probe.error ?? null,
  };
}

/** Wrap a fetch so every request carries the given headers. */
function withHeaders(
  fetchImpl: typeof fetch,
  headers: Record<string, string>,
): typeof fetch {
  return (input, init) =>
    fetchImpl(input, {
      ...init,
      headers: { ...(init?.headers as Record<string, string>), ...headers },
    });
}

/**
 * Host bucket for per-host serialization (#9959's mapLimit groupKey).
 *
 * api.github.com is deliberately given per-URL keys: the groupKey exists to
 * stop us fanning out on a small subnet's single-box API, and GitHub's API is
 * neither small nor ours to protect. Serializing its 429 checks would make it
 * the entire runtime of the sweep for no benefit.
 */
export function linkHostKey(url: string): string {
  const host = hostOf(url);
  if (linkCheckStrategy(url) === "github-api") return `github-api:${url}`;
  return host || url;
}

/**
 * Check many links, serialized per host, in a stable order.
 *
 * Order of results matches order of input — mapLimit guarantees that even when
 * grouping reorders the work.
 */
export async function checkLinks(
  urls: string[],
  deps: CheckLinkDeps = {},
  concurrency = LINK_CHECK_CONCURRENCY,
): Promise<Awaited<ReturnType<typeof checkLink>>[]> {
  return mapLimit(urls, concurrency, (url) => checkLink(url, deps), {
    groupKey: linkHostKey,
  });
}
