import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * /chain/emissions retired into the /chain emission section (#11619).
 *
 * The tab decomposed where each block's TAO goes, per subnet. That is a fact
 * about the chain in the same sense as its fees and its throughput, and the
 * rebuilt /chain says so by drawing it as one of its sections rather than as
 * a page a reader had to know existed.
 *
 * A permanent redirect rather than a deletion: this URL is in the sitemap, in
 * llms.txt, and in whatever agents and inbound links already point at it, so
 * deleting the route would answer them with a 404 instead of the page that now
 * holds the answer. 301 and not the framework's 307 default because the route
 * is RETIRED rather than temporarily moved — a temporary redirect tells a
 * search engine to keep the old URL and re-check it forever, while a permanent
 * one transfers the signals to /chain and lets the old URL drop out.
 *
 * None of `state`, `sort`, `dir`, `limit` or `netuid` is forwarded: every one
 * of them named a column or a filter of the per-subnet pipeline table, and that
 * table is not what the section draws. Carrying them over would put state on
 * /chain that nothing there can read.
 */
export const Route = createFileRoute("/chain/emissions")({
  beforeLoad: () => {
    throw redirect({ to: "/chain", hash: "emission", replace: true, statusCode: 301 });
  },
});
