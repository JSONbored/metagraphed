import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * /admin-changes merged into the Chain hub's Governance tab (#8291, part of
 * #8244) and is repointed at the /chain governance section by #11619, which
 * retired that tab into the page below it.
 *
 * Straight to the section, NOT to /chain/governance. This route pointed at
 * that one until #11619, and leaving it there would have made a two-hop chain —
 * /admin-changes 301 /chain/governance 301 /chain#governance — which spends a
 * crawl on a URL that is itself retired and loses PageRank on the extra hop. A
 * retired route redirects to a page that renders, never to another redirect.
 *
 * The search params are no longer forwarded, and neither is the `view: "admin"`
 * that used to pin this half of the merged tab: the section shows config
 * changes, sudo calls and runtime upgrades as one feed, so there is no half
 * left to pin and no table for a limit or a call filter to page.
 *
 * 301, not the 307 default: the route is permanently retired. A temporary
 * redirect tells a search engine to keep the old URL and re-check it forever;
 * a permanent one moves the signals to the new page and lets the old URL drop
 * out of the index.
 */
export const Route = createFileRoute("/admin-changes/")({
  beforeLoad: () => {
    throw redirect({ to: "/chain", hash: "governance", replace: true, statusCode: 301 });
  },
});
