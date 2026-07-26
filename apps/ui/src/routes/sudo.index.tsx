import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * /sudo merged into the Chain hub's Governance tab (#8291, part of #8244).
 * Sudo and AdminUtils are two halves of one root-origin surface, so they share
 * a page with a source toggle. Search params forward; `view` pins the Sudo half.
 */
export const Route = createFileRoute("/sudo/")({
  beforeLoad: ({ search }) => {
    throw redirect({
      to: "/chain/governance",
      search: { ...(search as Record<string, unknown>), view: "sudo" } as never,
      replace: true,
    });
  },
});
