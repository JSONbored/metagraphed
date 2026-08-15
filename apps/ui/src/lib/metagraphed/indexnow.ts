// IndexNow: tell Bing/Yandex which of OUR pages changed, and only those.
//
// WHY THE OBVIOUS DESIGN IS WRONG. The instinct is to submit whatever the
// registry's changelog reports as modified. Measured against the live endpoint
// on 2026-08-15, one publish reported **2,837 modified artifacts** — the
// 15-minute health probe rewrites nearly every artifact every time, so
// "artifact changed" says nothing about whether the PAGE changed. IndexNow's
// own guidance is to submit changed URLs, and submitting unchanged ones
// repeatedly is what gets a host's submissions discounted. A changelog-driven
// feed would have been a spam generator wearing the costume of a signal.
//
// So the change signal here is the GIT DIFF of a push to main: the content that
// produces a page is in this repo, and a page's content cannot change without
// one of these files changing. Rare by design — most pushes submit nothing,
// which is the correct behaviour, not a broken one.
//
// The key is deliberately PUBLIC. IndexNow authenticates by having the key
// readable at `https://<host>/<key>.txt`; that file IS the proof of ownership,
// so committing it is the protocol working as designed, not a leaked secret.

export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

/** IndexNow accepts at most 10,000 URLs in one submission. */
export const INDEXNOW_MAX_URLS = 10_000;

export interface IndexNowPayload {
  host: string;
  key: string;
  keyLocation: string;
  urlList: string[];
}

/**
 * Map one changed repository path to the public URL it produces, or null.
 *
 * Only paths whose page content is genuinely derived from that file. A route
 * component changing means the page RENDERS differently, but its content is the
 * same registry record — resubmitting all 129 subnets because a button moved is
 * exactly the noise this exists to avoid.
 */
export function urlForChangedPath(path: string, origin: string): string | null {
  // Docs MDX: apps/ui/content/docs/economics.mdx -> /docs/economics
  const doc = /^apps\/ui\/content\/docs\/(.+)\.mdx$/.exec(path);
  if (doc?.[1]) {
    // A folder's index page is the folder's own URL, not `/index`.
    const slug = doc[1].replace(/\/index$/, "");
    return `${origin}/docs/${slug}`.replace(/\/$/, "");
  }
  // Weekly digests: apps/ui/content/news/sn38/2026-w25.mdx -> /news/sn38/2026-w25.
  //
  // #11348: 285 pages that this job never submitted. The path filter watched
  // docs and the registry, and the digests are neither — so the one page family
  // whose whole value is being NEW was the one family never announced. Same
  // shape as the docs rule because they are the same kind of file.
  const news = /^apps\/ui\/content\/news\/(.+)\.mdx$/.exec(path);
  if (news?.[1]) {
    const slug = news[1].replace(/\/index$/, "");
    return `${origin}/news/${slug}`.replace(/\/$/, "");
  }
  // A STATIC route file: apps/ui/src/routes/subnets.with-api.tsx -> /subnets/with-api.
  //
  // Shipping a new route is exactly when a crawler most needs telling, and this
  // job was blind to it — /subnets/with-api had to be submitted by hand.
  //
  // Static only. A param route (`subnets.category.$slug.tsx`) expands to as many
  // URLs as there are values, which this function cannot know from a filename;
  // those are covered by the sitemap run. Files prefixed `-` are page
  // components, not routes, and `.test.` files are neither.
  const route = /^apps\/ui\/src\/routes\/([^/]+)\.tsx?$/.exec(path);
  if (
    route?.[1] &&
    !route[1].includes("$") &&
    !route[1].startsWith("-") &&
    !route[1].includes(".test")
  ) {
    const segments = route[1]
      .replace(/\.index$/, "")
      .replace(/^__root$/, "")
      .split(".")
      .filter((segment) => segment && segment !== "index");
    if (segments.length > 0) return `${origin}/${segments.join("/")}`;
  }
  // A subnet's registry record: registry/subnets/<slug>.json carries the
  // netuid in the file, not the name, so the caller resolves it — see
  // urlsForChangedPaths, which is given the netuid map.
  return null;
}

/**
 * Resolve a changed `registry/subnets/*.json` path to that subnet's netuid.
 *
 * A function, not a slug map, because the registry's FILE NAME is not the
 * subnet's slug and neither one is the page's URL segment. Measured: the file
 * is `registry/subnets/apex.json`, the API's `slug` is `sn-1`, and the page is
 * `/subnets/1`. Keying a map by the API slug matched nothing, so every changed
 * subnet was silently skipped — a feature that looked built and never fired.
 * The file itself declares `netuid`, so the caller reads it from the file.
 */
export type SubnetNetuidResolver = (repoPath: string) => number | null;

/**
 * Every URL a set of changed paths implies, deduped and ordered.
 *
 * A subnet whose netuid cannot be resolved is skipped rather than guessed at —
 * submitting a URL that 404s is worse than submitting nothing.
 */
export function urlsForChangedPaths(
  paths: string[],
  origin: string,
  netuidFor: SubnetNetuidResolver = () => null,
): string[] {
  const urls = new Set<string>();
  for (const path of paths) {
    const direct = urlForChangedPath(path, origin);
    if (direct) {
      urls.add(direct);
      continue;
    }
    if (/^registry\/subnets\/.+\.json$/.test(path)) {
      const netuid = netuidFor(path);
      if (netuid !== null) urls.add(`${origin}/subnets/${netuid}`);
      continue;
    }
    // A provider's file name IS its URL segment — verified against the live
    // registry, where `registry/providers/404-gen.json` serves /providers/404-gen.
    const provider = /^registry\/providers\/(.+)\.json$/.exec(path);
    if (provider?.[1]) urls.add(`${origin}/providers/${provider[1]}`);
  }
  return [...urls].sort();
}

/**
 * The submission body.
 *
 * `keyLocation` is stated explicitly even though the default location is the
 * one used: it is what lets the key file move later without every previously
 * submitted host record going stale.
 */
export function buildIndexNowPayload(
  urls: string[],
  origin: string,
  key: string,
): IndexNowPayload | null {
  const host = new URL(origin).host;
  // Only URLs on the host we hold the key for — IndexNow rejects a whole
  // submission that mixes hosts, so one stray URL would silently drop the lot.
  const urlList = [...new Set(urls.filter((url) => safeHost(url) === host))]
    .sort()
    .slice(0, INDEXNOW_MAX_URLS);
  if (urlList.length === 0) return null;
  return { host, key, keyLocation: `${origin}/${key}.txt`, urlList };
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
