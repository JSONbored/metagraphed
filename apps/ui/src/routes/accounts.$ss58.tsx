import { createFileRoute, notFound } from "@tanstack/react-router";
import { AppShell } from "@/components/metagraphed/app-shell";
import { EmptyState, PageHeading } from "@/components/metagraphed/states";
import { shortHash } from "@/lib/metagraphed/blocks";
import { isValidSs58 } from "@/lib/metagraphed/accounts";
import { entityNotFoundMeta } from "@/lib/metagraphed/entity-not-found-meta";
import { AccountDetailPage } from "./-accounts-ss58-page";

type SearchParams = {
  // #8358: the detail-page template's tab strip, same key/shape as
  // subnets.$netuid.tsx's `tab`.
  tab?: string;
  // Paginated /events feed controls (#266). Prefixed so they never collide with
  // other future per-account search params.
  ev_kind?: string;
  ev_limit?: number;
  ev_offset?: number;
};

const EVENTS_LIMITS = [25, 50, 100, 200] as const;
export const DEFAULT_EVENTS_LIMIT = 25;

export const Route = createFileRoute("/accounts/$ss58")({
  validateSearch: (s: Record<string, unknown>): SearchParams => {
    const limitNum = Number(s.ev_limit);
    const offsetNum = Number(s.ev_offset);
    return {
      tab: typeof s.tab === "string" ? s.tab : undefined,
      ev_kind: typeof s.ev_kind === "string" && s.ev_kind ? s.ev_kind : undefined,
      ev_limit: (EVENTS_LIMITS as readonly number[]).includes(limitNum) ? limitNum : undefined,
      ev_offset: Number.isInteger(offsetNum) && offsetNum > 0 ? offsetNum : undefined,
    };
  },
  // #6429: validate the ss58 at the router level, matching blocks.$ref.tsx
  // (#3422) and subnets.$netuid.tsx. parseParams runs before head()/the loader,
  // so an invalid address renders the real not-found boundary instead of a
  // fully-formed page whose metadata interpolates the bad param.
  parseParams: ({ ss58 }) => {
    if (!isValidSs58(ss58)) throw notFound();
    return { ss58 };
  },
  head: ({ params }) => {
    // parseParams above rejects a malformed ss58, but head() still runs with the
    // raw param -- verified against the routes that already validate: /blocks/
    // not-a-ref titles "Block not-a-ref" and /subnets/not-a-netuid titles
    // "Subnet not-a-netuid" today. So the not-found metadata is guarded here
    // too, or the boundary would render under a title asserting the bad id is a
    // real account (#6429).
    if (!isValidSs58(params.ss58)) {
      return entityNotFoundMeta(
        "Account",
        "This account identifier is not a valid Bittensor ss58 address.",
      );
    }
    const label = shortHash(params.ss58) ?? params.ss58;
    const title = `Account ${label} — Metagraphed`;
    const description = `Bittensor account ${label}: cross-subnet activity, registrations, and first-party chain-event history on Metagraphed.`;
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
      ],
    };
  },
  notFoundComponent: () => (
    <AppShell>
      <PageHeading
        eyebrow="Explorer"
        title="Invalid account address"
        description="Account addresses are ss58 (base58) strings, 46–49 characters long."
      />
      <EmptyState
        title="Invalid account address"
        description="Bittensor addresses use the base58 alphabet (no 0, O, I, or l), are 46–49 characters long, and typically start with 5. Check for a truncated or wrong-chain address, then try again."
        action={{ label: "Back to accounts", href: "/accounts" }}
      />
      <p className="mt-3 text-center text-[11px] text-ink-muted">
        Example:{" "}
        <span className="font-mono break-all text-ink-strong">
          5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY
        </span>
      </p>
    </AppShell>
  ),
  component: AccountDetailPage,
});
