import { createFileRoute, redirect } from "@tanstack/react-router";

/** /events moved into the Chain hub (#8291, part of #8244). */
export const Route = createFileRoute("/events/")({
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/chain/events", search, replace: true });
  },
});
