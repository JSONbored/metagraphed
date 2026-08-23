import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * /subnets/category is an intermediate path segment of every category URL, and
 * #11283's gate is what caught it 404ing — a linked breadcrumb crumb pointing
 * at nothing, the exact defect that put 129 dead prefixes on the site (#11303).
 *
 * #11613 retired the category pages themselves into the /subnets domain
 * filter, so this segment now sends a reader to the domain section of the index
 * rather than to a listing of pages that no longer exist. It stays a redirect
 * rather than a deletion for the reason it was one to begin with: breadcrumbs
 * and inbound links reach it, and this segment will never be a page — the same
 * answer /graphql, /tools and /design give.
 *
 * 301 and not the framework's 307 default because the move is permanent: a
 * temporary redirect tells a search engine to keep the old URL and re-check it,
 * while a permanent one transfers the signals to /subnets.
 */
export const Route = createFileRoute("/subnets/category/")({
  beforeLoad: () => {
    throw redirect({ to: "/subnets", hash: "domains", replace: true, statusCode: 301 });
  },
});
