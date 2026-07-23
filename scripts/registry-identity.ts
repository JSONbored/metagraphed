// Registry-identity helpers: owner-token matching (does a community-submitted
// surface's URL belong to the provider it claims?) + GitHub-login normalization.
// Extracted from the retired submission preflight (submission-policy.mjs) because
// the candidate→surface promotion in scripts/generated-overlays.ts and the
// surface:add intake still depend on them — they are the only live survivors of
// that module. Pure + dependency-light so they stay unit-covered.
import { clusterDomainFromUrl, MULTI_TENANT_HOST_SUFFIXES } from "./lib.ts";

type Row = Record<string, unknown>;

const CODE_HOST_RE = /^(github\.com|gitlab\.com|bitbucket\.org)$/i;
const normIdentToken = (value: unknown): string =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
const isMultiTenantClusterDomain = (domain: unknown): boolean =>
  typeof domain === "string" &&
  [...MULTI_TENANT_HOST_SUFFIXES].some((suffix) =>
    domain.toLowerCase().endsWith(`.${suffix}`),
  );

/** Owner token(s) a URL claims — a code host (github/gitlab/bitbucket) contributes its ORG; any other
 *  host contributes its registrable-domain label. Normalized to alnum, ≥4 chars except short
 *  multi-tenant labels, which are still tenant-controlled owner claims and must not disappear. */
export function urlOwnerTokens(value: unknown): string[] {
  if (typeof value !== "string" || !value) return [];
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return [];
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const out: string[] = [];
  if (CODE_HOST_RE.test(host)) {
    const org = url.pathname.replace(/^\/+/, "").split("/")[0];
    const token = normIdentToken(org);
    if (token.length >= 4) out.push(token);
  } else {
    const domain = clusterDomainFromUrl(value);
    if (domain) {
      const token = normIdentToken(domain.split(".")[0]);
      if (token.length >= 4 || isMultiTenantClusterDomain(domain)) {
        out.push(token);
      }
    }
  }
  return out.filter(Boolean);
}

/** Identity tokens for a candidate's declared provider — its name, id, and the owner tokens of its
 *  official website/docs/github. Used to check an ownership-sensitive candidate's URL belongs to it. */
export function providerIdentityTokens(provider: unknown): string[] {
  if (!provider || typeof provider !== "object") return [];
  const providerRow = provider as Row;
  const out = new Set<string>();
  for (const field of ["name", "id"]) {
    const token = normIdentToken(providerRow[field]);
    if (token.length >= 4) out.add(token);
  }
  for (const field of ["website_url", "docs_url", "github_url"]) {
    for (const token of urlOwnerTokens(providerRow[field])) out.add(token);
  }
  return [...out];
}

/** Two identity tokens are "related" — EXACTLY equal, or one contains the other with the shorter
 *  (discriminating) token ≥8 chars, so a short generic/forgeable token (sn76, vision, data, network)
 *  can only match by exact equality, never by being a substring of an attacker org. (adversarial) */
export function ownerTokensRelated(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= 8 && longer.includes(shorter);
}

/** github org "luminarnetwork" matches provider name token "luminarnetwork" (exact); "safescanai" does
 *  not match "byzantium". Empty token set → can't determine → don't block. */
export function ownerTokensMatch(
  claimTokens: string[],
  identityTokens: string[],
): boolean {
  if (claimTokens.length === 0 || identityTokens.length === 0) return true;
  return claimTokens.some((claim) =>
    identityTokens.some((identity) => ownerTokensRelated(claim, identity)),
  );
}

/** Canonical GitHub login: strip a leading @, a github.com/ profile prefix, and a trailing slash,
 *  lower-cased. Used to attribute a community submission to its submitter. */
export function normalizeGitHubLogin(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/^@/, "")
    .replace(/^https:\/\/github\.com\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}
