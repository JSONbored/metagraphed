import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Bare /chain lands on Blocks for now.
 *
 * The Overview tab that will own this path arrives with #8292, which retires
 * /explorer into it. Until then a redirect is honest: the hub exists and has a
 * sensible default, rather than rendering an empty shell.
 */
export const Route = createFileRoute("/chain/")({
  beforeLoad: () => {
    throw redirect({ to: "/chain/blocks", replace: true });
  },
});
