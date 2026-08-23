import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * /revenue retired into the /subnets rankings section (#11613).
 *
 * The page ranked subnets by what they earn outside Bittensor against what the
 * network emits to them. That is a ranking OF SUBNETS, which is what the
 * rankings section of /subnets is for — keeping it as its own top-level route
 * split one question across two pages and made the reader find the second one.
 *
 * A permanent redirect rather than a deletion: this URL is in the sitemap, in
 * llms.txt, and in whatever agents and inbound links already point at it, so
 * deleting the route would answer them with a 404 instead of the page that now
 * holds the answer. 301 and not the framework's 307 default because the route
 * is RETIRED rather than temporarily moved — a temporary redirect tells a
 * search engine to keep the old URL and re-check it, while a permanent one
 * transfers the signals to /subnets and lets the old URL drop out.
 *
 * The sort/provenance search params are deliberately not forwarded. They named
 * columns of a table that no longer exists, so carrying them across would put
 * state on /subnets that nothing there can read.
 */
export const Route = createFileRoute("/revenue")({
  beforeLoad: () => {
    throw redirect({ to: "/subnets", hash: "rankings", replace: true, statusCode: 301 });
  },
});
