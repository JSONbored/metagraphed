import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * /gaps renamed to /contribute (#8304, part of #8245).
 *
 * It was never a browse destination — it is the contributor work queue, which
 * is why it sat in the public nav describing work nobody browsing wanted to do.
 * Search params forward so an existing filtered link keeps working.
 */
export const Route = createFileRoute("/gaps")({
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/contribute", search, replace: true });
  },
});
