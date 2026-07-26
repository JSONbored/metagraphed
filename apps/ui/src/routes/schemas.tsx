import { createFileRoute, redirect } from "@tanstack/react-router";

/** /schemas moved into the APIs hub (#8303, part of #8245). */
export const Route = createFileRoute("/schemas")({
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/apis/schemas", search, replace: true });
  },
});
