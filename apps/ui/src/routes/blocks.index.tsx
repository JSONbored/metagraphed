import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * /blocks moved into the Chain hub (#8290, part of #8244).
 *
 * A permanent redirect rather than a deletion: this URL is in the sitemap, in
 * llms.txt, and in whatever agents and links already point at it. Search params
 * are forwarded so an existing filtered/paged link keeps working.
 *
 * The DETAIL route (/blocks/$ref) deliberately keeps its own URL — only index
 * pages consolidate, so every deep link to a specific block still resolves.
 */
export const Route = createFileRoute("/blocks/")({
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/chain/blocks", search, replace: true });
  },
});
