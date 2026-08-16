import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * /admin-changes merged into the Chain hub's Governance tab (#8291, part of
 * #8244). Search params forward; `view` pins the AdminUtils half.
 */
export const Route = createFileRoute("/admin-changes/")({
  beforeLoad: ({ search }) => {
    throw redirect({
      to: "/chain/governance",
      search: { ...(search as Record<string, unknown>), view: "admin" },
      replace: true,
      // 301, not the 307 default: this route is permanently retired. A
      // temporary redirect tells a search engine to keep the old URL and
      // re-check it forever; a permanent one moves the signals to the new
      // page and lets the old URL drop out of the index.
      statusCode: 301,
    });
  },
});
