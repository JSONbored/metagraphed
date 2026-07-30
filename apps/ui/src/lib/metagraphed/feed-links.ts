// Feed autodiscovery links (#8703).
//
// The feed system (#741) has served RSS 2.0, Atom 1.0 and JSON Feed 1.1 since
// it shipped, and no page on this site ever advertised it. Without a
// `<link rel="alternate">` in the document head, a browser, a feed reader, or a
// crawler has no way to get from a page to its feed — a reader handed
// `https://metagraph.sh/subnets/8` simply reports that it found nothing. This
// module is the missing tag.
//
// RSS AND ATOM, NOT JSON FEED. All three serializations exist and the contract
// documents all three, but autodiscovery is a reader-facing convention and
// readers overwhelmingly probe for `application/rss+xml` and
// `application/atom+xml`. JSON Feed's own spec points readers at those two for
// discovery and expects the JSON variant to be found from inside the feed or by
// a caller that already knows the URL — which, here, is the OpenAPI contract.
// Advertising a third alternate would add a link most readers ignore.
//
// The `title` matters: a reader that finds two alternates on one page shows
// these strings in its subscribe dialog, so they have to distinguish the feeds
// rather than both reading "Feed".

import { API_BASE } from "./config";

/** A `<link rel="alternate">` descriptor, in TanStack Router's head() shape. */
export interface FeedLink {
  rel: "alternate";
  type: string;
  href: string;
  title: string;
}

/**
 * Build the RSS + Atom autodiscovery pair for one feed path.
 *
 * `feedPath` is the path under `/api/v1/feeds` WITHOUT a format suffix — e.g.
 * `"registry"` or `"subnets/8"`. The suffix is appended here so the two links
 * cannot drift out of sync, and so a caller cannot accidentally advertise a
 * `.json` URL as `application/rss+xml`.
 */
export function feedAutodiscoveryLinks(feedPath: string, title: string): FeedLink[] {
  const base = `${API_BASE}/api/v1/feeds/${feedPath}`;
  return [
    {
      rel: "alternate",
      type: "application/rss+xml",
      href: `${base}.rss`,
      title,
    },
    {
      rel: "alternate",
      type: "application/atom+xml",
      href: `${base}.atom`,
      title: `${title} (Atom)`,
    },
  ];
}

/** The site-wide registry feed, advertised from the root layout. */
export function registryFeedLinks(): FeedLink[] {
  return feedAutodiscoveryLinks("registry", "Metagraphed — registry changes and runtime upgrades");
}

/** One subnet's combined registry + incidents feed. */
export function subnetFeedLinks(netuid: number | string): FeedLink[] {
  return feedAutodiscoveryLinks(
    `subnets/${netuid}`,
    `Metagraphed — subnet ${netuid} changes and incidents`,
  );
}
