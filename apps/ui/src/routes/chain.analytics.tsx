import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * /chain/analytics retired into the /chain stake-flow section (#11619).
 *
 * The tab held the stake-flow rails, the concentration and emission trends and
 * the registration economics — four readings OF the chain, one tab away from
 * the page that answers "what is the chain doing". The rebuilt /chain renders
 * them as sections of that page, so the tab was a second navigation to reach
 * numbers the reader had already asked for.
 *
 * A permanent redirect rather than a deletion: this URL is in the sitemap, in
 * llms.txt, and in whatever agents and inbound links already point at it, so
 * deleting the route would answer them with a 404 instead of the page that now
 * holds the answer. 301 and not the framework's 307 default because the route
 * is RETIRED rather than temporarily moved — a temporary redirect tells a
 * search engine to keep the old URL and re-check it forever, while a permanent
 * one transfers the signals to /chain and lets the old URL drop out.
 *
 * `stake-flow` rather than bare /chain: the first thing this tab drew was the
 * sankey, and a link that lands on the top of a seven-section page has kept
 * the pathname and lost the question.
 *
 * The `window` search param is deliberately not forwarded. It drove one control
 * on a page that no longer exists; the sections own their own ranges, and a
 * param nothing there reads would be state carried across for its own sake.
 */
export const Route = createFileRoute("/chain/analytics")({
  beforeLoad: () => {
    throw redirect({ to: "/chain", hash: "stake-flow", replace: true, statusCode: 301 });
  },
});
