import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * /endpoints moved into the APIs hub (#8302, part of #8245). Search params
 * forward so an existing filtered/sorted link keeps working.
 */
export const Route = createFileRoute("/endpoints")({
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/apis/endpoints", search, replace: true });
  },
});
