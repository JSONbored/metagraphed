import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * /admin-changes merged into the Chain hub's Governance tab (#8291, part of
 * #8244). Search params forward; `view` pins the AdminUtils half.
 */
export const Route = createFileRoute("/admin-changes/")({
  beforeLoad: ({ search }) => {
    throw redirect({
      to: "/chain/governance",
      search: { ...(search as Record<string, unknown>), view: "admin" } as never,
      replace: true,
    });
  },
});
