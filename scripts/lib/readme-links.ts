// README link selection + classification helpers, extracted verbatim from
// scripts/lib.ts (#510 maintainability decomposition). Pure functions over
// plain strings/objects with no module state and no I/O. Re-exported from
// scripts/lib.ts so existing importers (scripts/discover-candidates.ts, tests)
// keep their import paths unchanged.
//
// `registrableDomain` delegates to `registrableHostDomain` in lib.ts for
// multi-label public suffix handling (#1636) so README dedupe keys cannot drift.

import { registrableHostDomain } from "../lib.ts";

// README candidate links / repo descriptors are untrusted, deeply-nested
// discovery data, read only for classification purposes -- never trusted for
// control flow. Mirrors the readJson/readArtifactJson precedent in lib.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export const README_LINK_LIMIT = 5;

export const README_KIND_LIMITS: Record<string, number> = {
  dashboard: 2,
  "data-artifact": 1,
  docs: 1,
  openapi: 2,
  "subnet-api": 2,
  website: 1,
};

// #1008: detect a code-example / quickstart link from a normalized haystack
// (`"<label> <hostname> <pathname>"`, lowercased). `/example` matches both
// `/example/` and `/examples/`. Pure + exported so the discovery classifier and
// its tests share one definition. Callers check this AHEAD of the generic
// api/docs heuristics so an examples dir is not mis-bucketed.
export function isLikelyExampleLink(haystack: unknown): boolean {
  if (typeof haystack !== "string") return false;
  return (
    haystack.includes("/example") ||
    haystack.includes("quickstart") ||
    haystack.includes("quick-start") ||
    haystack.includes("getting-started") ||
    haystack.includes("/tutorial") ||
    haystack.includes(".ipynb") ||
    haystack.includes("colab.research.google")
  );
}

const GENERIC_README_REFERENCE_HOSTS = [
  "arxiv.org",
  "astral.sh",
  "bittensor.com",
  "docs.google.com",
  "ico.org.uk",
  "kubernetes.io",
  "learnbittensor.org",
  "nextjs.org",
  "openai.com",
  "pm2.io",
  "python.org",
  "subnetradar.com",
  "taomarketcap.com",
  "taostats.io",
];

const README_AFFINITY_STOPWORDS = new Set([
  "ai",
  "api",
  "app",
  "bittensor",
  "docs",
  "github",
  "inc",
  "io",
  "labs",
  "ltd",
  "main",
  "miner",
  "network",
  "org",
  "protocol",
  "repo",
  "subnet",
  "the",
  "validator",
  "www",
]);

interface ReadmeLinkSelectionOptions {
  limit?: number;
  netuid?: unknown;
  repo?: { owner?: string; repo?: string };
}

export function selectReviewableReadmeLinks(
  links: Row[] | undefined,
  { limit = README_LINK_LIMIT, netuid, repo }: ReadmeLinkSelectionOptions = {},
): Row[] {
  const selected: Row[] = [];
  const seen = new Set<string>();
  const kindCounts = new Map<string, number>();

  for (const link of links || []) {
    if (!isReviewableReadmeLink(link, { netuid, repo })) {
      continue;
    }

    const key = readmeDedupeKey(link);
    if (seen.has(key)) {
      continue;
    }

    const kind = link.classification.kind;
    const kindLimit = README_KIND_LIMITS[kind] || 1;
    if ((kindCounts.get(kind) || 0) >= kindLimit) {
      continue;
    }

    seen.add(key);
    kindCounts.set(kind, (kindCounts.get(kind) || 0) + 1);
    selected.push(link);

    if (selected.length >= limit) {
      break;
    }
  }

  return selected;
}

export function isReviewableReadmeLink(
  link: Row,
  { netuid, repo }: ReadmeLinkSelectionOptions = {},
): boolean {
  if (!link?.url || !link.classification?.kind) {
    return false;
  }

  if (isGenericReadmeReferenceHost(link.url)) {
    return false;
  }

  return hasReadmeProjectAffinity(link, { netuid, repo });
}

function readmeDedupeKey(link: Row): string {
  try {
    return `${link.classification.kind}:${registrableDomain(
      new URL(link.url).hostname,
    )}`;
  } catch {
    return `${link.classification.kind}:${String(link.url || "").toLowerCase()}`;
  }
}

function isGenericReadmeReferenceHost(value: unknown): boolean {
  try {
    const host = normalizeHost(new URL(value as string).hostname);
    return GENERIC_README_REFERENCE_HOSTS.some(
      (genericHost) => host === genericHost || host.endsWith(`.${genericHost}`),
    );
  } catch {
    return true;
  }
}

function hasReadmeProjectAffinity(
  link: Row,
  { netuid, repo }: ReadmeLinkSelectionOptions = {},
): boolean {
  let url;
  try {
    url = new URL(link.url);
  } catch {
    return false;
  }

  const rawHaystack = [url.hostname, url.pathname, url.search, link.label || ""]
    .join(" ")
    .toLowerCase();
  const compactHaystack = compactReadmeValue(rawHaystack);

  if (Number.isInteger(netuid) && hasNetuidAffinity(rawHaystack, netuid)) {
    return true;
  }

  return repoTokens(repo).some((token) => compactHaystack.includes(token));
}

function hasNetuidAffinity(value: string, netuid: unknown): boolean {
  const escaped = String(netuid).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`(^|[^a-z0-9])sn[-_ ]?${escaped}([^a-z0-9]|$)`, "i"),
    new RegExp(`(^|[^a-z0-9])subnets?[-_/= ]?${escaped}([^a-z0-9]|$)`, "i"),
  ];
  if (patterns.some((pattern) => pattern.test(value))) {
    return true;
  }

  // Bound the trailing edge so a short netuid isn't matched as the prefix of a
  // longer number (netuid 1 must not match "sn123" / "subnets1000"). The leading
  // edge can't be enforced on the compacted value — compaction strips the
  // separators that would delimit it (e.g. "example.com/sn1" -> "examplecomsn1")
  // — so only guard the digit boundary immediately after the netuid.
  const compactValue = compactReadmeValue(value);
  return new RegExp(`(sn|subnets?)${escaped}(?![0-9])`).test(compactValue);
}

function repoTokens(repo: { owner?: string; repo?: string } = {}): string[] {
  const rawTokens = `${repo.owner || ""} ${repo.repo || ""}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const compactTokens = [
    compactReadmeValue(repo.owner || ""),
    compactReadmeValue(repo.repo || ""),
  ].filter(Boolean);

  return [
    ...new Set(
      [...rawTokens, ...compactTokens].map(compactReadmeValue).filter(Boolean),
    ),
  ].filter(
    (token) => token.length >= 3 && !README_AFFINITY_STOPWORDS.has(token),
  );
}

function compactReadmeValue(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function normalizeHost(hostname: unknown): string {
  return String(hostname || "")
    .toLowerCase()
    .replace(/^www\./, "");
}

function registrableDomain(hostname: unknown): string {
  return registrableHostDomain(normalizeHost(hostname));
}
