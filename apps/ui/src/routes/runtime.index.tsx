import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * /runtime moved into the Chain hub (#8291, part of #8244) and is repointed at
 * the /chain governance section by #11619, which retired /chain/runtime too.
 *
 * Straight to the section, NOT to /chain/runtime. This route pointed at that
 * one until #11619, and leaving it there would have made a two-hop chain —
 * /runtime 301 /chain/runtime 301 /chain#governance — which spends a crawl on
 * a URL that is itself retired and loses PageRank on the extra hop. A retired
 * route redirects to a page that renders, never to another redirect.
 *
 * 301, not the 307 default: the route is permanently retired. A temporary
 * redirect tells a search engine to keep the old URL and re-check it forever;
 * a permanent one moves the signals to the new page and lets the old URL drop
 * out of the index.
 */
export const Route = createFileRoute("/runtime/")({
  beforeLoad: () => {
    throw redirect({ to: "/chain", hash: "governance", replace: true, statusCode: 301 });
  },
});
