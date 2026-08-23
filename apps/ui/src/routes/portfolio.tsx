import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * /portfolio retired (#8252), repointed to /settings#wallet by #11627.
 *
 * A whole route for a wallet-connect prompt was exactly the near-empty page
 * this redesign consolidates. #8252 sent it to /accounts, where the connect
 * panel then lived; #11615 rebuilt /accounts without it, and the panel now
 * sits in the Wallet section of /settings beside the watchlist it belongs
 * with. This redirect follows it rather than landing on a page that no longer
 * has what the URL promised.
 */
export const Route = createFileRoute("/portfolio")({
  beforeLoad: () => {
    throw redirect({ to: "/settings", hash: "wallet", replace: true, statusCode: 301 });
  },
});
