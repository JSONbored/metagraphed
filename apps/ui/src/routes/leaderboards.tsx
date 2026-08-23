import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * /leaderboards retired into the /subnets rankings section (#11613).
 *
 * #8311 folded the boards themselves into /subnets and left this route
 * redirecting at `?section=rankings`. The rebuilt index does not read that
 * search param — the sections are anchored headings now — so the destination
 * is the `rankings` hash, and the `window` range is owned by the section's own
 * control rather than carried in from a route that no longer renders anything.
 *
 * A permanent redirect rather than a deletion: this URL is in the sitemap, in
 * llms.txt, and in whatever agents and inbound links already point at it. 301
 * and not the framework's 307 default because the route is RETIRED rather than
 * temporarily moved — a temporary redirect tells a search engine to keep the
 * old URL and re-check it, while a permanent one transfers the signals to
 * /subnets and lets the old URL drop out.
 */
export const Route = createFileRoute("/leaderboards")({
  beforeLoad: () => {
    throw redirect({ to: "/subnets", hash: "rankings", replace: true, statusCode: 301 });
  },
});
