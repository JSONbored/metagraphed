import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * /chain/governance retired into the /chain governance section (#11619).
 *
 * #8291 built this tab by merging /sudo and /admin-changes, on the reasoning
 * that Sudo calls and AdminUtils config changes are two halves of one
 * root-origin surface. That reasoning did not stop at the tab boundary: they
 * are also two halves of what the chain did, which is what /chain is, so the
 * merged feed is now a section of it.
 *
 * A permanent redirect rather than a deletion: this URL is in the sitemap, in
 * llms.txt, and in whatever agents and inbound links already point at it, so
 * deleting the route would answer them with a 404 instead of the page that now
 * holds the answer. 301 and not the framework's 307 default because the route
 * is RETIRED rather than temporarily moved — a temporary redirect tells a
 * search engine to keep the old URL and re-check it forever, while a permanent
 * one transfers the signals to /chain and lets the old URL drop out.
 *
 * The `view` toggle is not forwarded, and cannot be: the section shows both
 * origins in one list rather than one at a time, so there is no half for a
 * `sudo` or `admin` value to pin. `limit`, `offset`, `call_function` and
 * `success` go the same way — they paged and filtered a table that no longer
 * exists.
 */
export const Route = createFileRoute("/chain/governance")({
  beforeLoad: () => {
    throw redirect({ to: "/chain", hash: "governance", replace: true, statusCode: 301 });
  },
});
