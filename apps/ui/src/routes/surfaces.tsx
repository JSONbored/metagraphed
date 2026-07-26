import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * /surfaces moved into the APIs hub as the Catalog tab (#8302, part of #8245).
 * Surfaces and Endpoints were one concept split across two pages that both
 * advertised the same "3,101 tracked" count. Search params forward so an
 * existing filtered link keeps working.
 */
export const Route = createFileRoute("/surfaces")({
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/apis", search, replace: true });
  },
});
