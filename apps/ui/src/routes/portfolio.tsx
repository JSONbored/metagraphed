import { createFileRoute, redirect } from "@tanstack/react-router";

// #8252: /portfolio retired into /accounts as the "Your wallet" panel — a
// whole route for a wallet-connect prompt was exactly the near-empty page the
// redesign consolidates. The read-only connect flow itself is unchanged, it
// just lives beside the account lookup it belongs with now.
export const Route = createFileRoute("/portfolio")({
  beforeLoad: () => {
    throw redirect({ to: "/accounts", replace: true });
  },
});
