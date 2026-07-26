import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * /explorer retired into the Chain hub's Overview tab (#8292, completing
 * #8244). Its content WAS the hub's overview — keeping both would have meant
 * two pages showing the same network-at-a-glance stats. Search params forward
 * so an existing ?window=30d link still lands on the same view.
 */
export const Route = createFileRoute("/explorer")({
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/chain", search, replace: true });
  },
});
