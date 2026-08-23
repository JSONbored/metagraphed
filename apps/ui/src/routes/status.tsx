import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * /status retired into /health (#11625).
 *
 * The page asked one question — is metagraphed itself up — and a reader asks
 * it in the same breath as "is anything else". It is the fourth section of
 * /health now, with the same verdict, the same per-component ratios and the
 * same day series.
 *
 * A permanent redirect rather than a deletion: this URL is in the sitemap, in
 * llms.txt, in the footer of every page that has ever shipped, and in whatever
 * status-page aggregators point at it. 301 and not the framework's 307 default
 * because the route is RETIRED rather than temporarily moved.
 *
 * The `#self-health` fragment lands on the section that was this page, not on
 * the top of a four-section one. `date`, `kind`, `status`, `sort` and `order`
 * are deliberately not forwarded: every one of them drove the probe-history
 * drill-down table, which is not what the section draws.
 */
export const Route = createFileRoute("/status")({
  beforeLoad: () => {
    throw redirect({ to: "/health", hash: "self-health", replace: true, statusCode: 301 });
  },
});
