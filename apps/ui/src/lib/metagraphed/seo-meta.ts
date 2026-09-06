/**
 * Pure helpers and constants for what a search result shows (#11204 item 5).
 *
 * Separate from json-ld.ts, which builds structured data: this is the prose a
 * human reads in a result, and it is tuned to measured demand rather than to
 * what reads nicely internally. Deliberately dependency-free, so the Worker
 * entry and a route component can both import it.
 */

// The public identity constants live in their own dependency-free module
// (identity.ts) because the Worker entry imports them too; re-exported here so
// a caller shaping SEO text does not need to know that.
export { SITE_ORIGIN } from "./identity";

/**
 * `https://github.com/owner/name` -> `owner/name`.
 *
 * Search Console shows the queries that already rank us are subnet lookups,
 * several of them a repository URL pasted verbatim (`github.com/chronollm/sn38`).
 * The slug is therefore worth carrying in a description, where it can match
 * that query — but only when the registry actually holds a repo URL, and only
 * when it parses to a real `owner/name` pair.
 *
 * Returns null for anything else (a bare host, a gist, a non-URL, a
 * non-GitHub forge) rather than guessing: a wrong attribution in a snippet is
 * worse than an absent one, which is the same rule the registry publishes
 * under.
 */
export function repoSlugFrom(repo: string | null | undefined): string | null {
  if (!repo) return null;
  let url: URL;
  try {
    url = new URL(repo);
  } catch {
    return null;
  }
  if (!/(^|\.)github\.com$/i.test(url.hostname)) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const [owner, name] = segments;
  // `/orgs/x`, `/sponsors/x` and friends are GitHub's own routes, not repos.
  if (["orgs", "sponsors", "users", "settings", "topics"].includes(owner.toLowerCase())) {
    return null;
  }
  return `${owner}/${name.replace(/\.git$/i, "")}`;
}

/** One page's search and social text, with no renderer or data-fetch dependency. */
export function pageMeta(title: string, description: string) {
  return [
    { title },
    { name: "description", content: description },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
  ];
}
