import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * /providers index moved into the APIs hub (#8303, part of #8245).
 * /providers/$slug deliberately keeps its own URL -- only index pages
 * consolidate, so every existing link to a specific provider still resolves.
 */
export const Route = createFileRoute("/providers/")({
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/apis/providers", search, replace: true });
  },
});
