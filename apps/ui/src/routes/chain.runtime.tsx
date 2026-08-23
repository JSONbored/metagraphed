import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * /chain/runtime retired into the /chain governance section (#11619).
 *
 * The tab listed spec-version upgrades, newest first, beside the network
 * parameters those upgrades change. A runtime upgrade is a change to how the
 * chain runs, made by the same root origin as a sudo call and an AdminUtils
 * config change — so the three are one feed in the governance section rather
 * than a page of their own next to a page of the other two.
 *
 * Governance, not a `runtime` anchor: the section is the merged feed, and
 * pointing this URL at a heading that does not exist would be a redirect to
 * the top of the page wearing a fragment.
 *
 * A permanent redirect rather than a deletion: this URL is in the sitemap, in
 * llms.txt, and in whatever agents and inbound links already point at it, so
 * deleting the route would answer them with a 404 instead of the page that now
 * holds the answer. 301 and not the framework's 307 default because the route
 * is RETIRED rather than temporarily moved — a temporary redirect tells a
 * search engine to keep the old URL and re-check it forever, while a permanent
 * one transfers the signals to /chain and lets the old URL drop out.
 */
export const Route = createFileRoute("/chain/runtime")({
  beforeLoad: () => {
    throw redirect({ to: "/chain", hash: "governance", replace: true, statusCode: 301 });
  },
});
