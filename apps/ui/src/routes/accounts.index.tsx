import { createFileRoute } from "@tanstack/react-router";
import { AccountsPage } from "./-accounts-index-page";

export const Route = createFileRoute("/accounts/")({
  /**
   * `?h160=` — where a pasted EVM address lands (metagraphed-infra#373).
   *
   * `/api/v1/search/resolve` has always answered an H160 with
   * `ui_path: /accounts?h160=0x…`, and this route had no `validateSearch` at
   * all, so the parameter was parsed by nothing and dropped: the one identifier
   * the resolver marks `exact: true` sent the user to a generic account index
   * with their address silently discarded.
   *
   * Kept out of the resolver on purpose. Turning an H160 into an account is a
   * LOOKUP, and the resolver is lookup-free so that every other shape stays an
   * instant, offline answer — so the second request belongs here, on the page
   * that needs it.
   */
  // The return type is `{ h160?: string }` and not `{ h160: string | undefined }`
  // deliberately: TanStack treats a validated route's `search` as REQUIRED
  // unless `{}` is assignable to it, and the second spelling makes every
  // existing `redirect({ to: "/accounts" })` a type error.
  validateSearch: (search: Record<string, unknown>): { h160?: string } =>
    typeof search.h160 === "string" ? { h160: search.h160 } : {},
  head: () => ({
    meta: [
      { title: "Accounts — Metagraphed" },
      {
        name: "description",
        content:
          "Look up a Bittensor account (hotkey or coldkey) — cross-subnet activity, registrations, and first-party chain-event history.",
      },
      { property: "og:title", content: "Accounts — Metagraphed" },
      {
        property: "og:description",
        content:
          "Look up a Bittensor account (hotkey or coldkey) — cross-subnet activity, registrations, and chain-event history.",
      },
    ],
  }),
  component: AccountsPage,
});
