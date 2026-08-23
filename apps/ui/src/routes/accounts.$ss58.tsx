import { createFileRoute, notFound } from "@tanstack/react-router";
import { z } from "zod";
import { TRAILING_WINDOWS, stripDefaultSearchParams } from "@/lib/metagraphed/url-state";
import { AppShell } from "@/components/metagraphed/app-shell";
import { EmptyState, PageHeading } from "@/components/metagraphed/states";
import { resolveAddress } from "@/lib/metagraphed/resolve-address";
import { isValidSs58 } from "@/lib/metagraphed/accounts";
import {
  entityNotFoundMeta,
  isMissingEntityError,
  isNotFoundMatch,
} from "@/lib/metagraphed/entity-not-found-meta";
import { formatNumber } from "@/lib/metagraphed/format";
import { ogImageMeta } from "@/lib/metagraphed/og-card";
import { accountQuery } from "@/lib/metagraphed/queries";
import { AccountDetailPage } from "./-accounts-ss58-page";

/**
 * One key: the window the Flow section totals over.
 *
 * The tab strip and the three `ev_*` feed controls went with the UI that read
 * them (#11614) -- the events feed is one infinite table with a kind filter
 * now, and its paging is a cursor the URL never carried. `validateSearch`
 * REPLACES the search object, so a key with no reader is dropped on the next
 * parse rather than sitting inert.
 */
export const accountSearchSchema = z.object({
  window: z.enum(TRAILING_WINDOWS).catch("30d").default("30d"),
});

export type SearchParams = z.infer<typeof accountSearchSchema>;

export const Route = createFileRoute("/accounts/$ss58")({
  validateSearch: accountSearchSchema,
  search: { middlewares: [stripDefaultSearchParams(accountSearchSchema)] },
  // #6429: validate the ss58 at the router level, matching blocks.$ref.tsx
  // (#3422) and subnets.$netuid.tsx. parseParams runs before head()/the loader,
  // so an invalid address renders the real not-found boundary instead of a
  // fully-formed page whose metadata interpolates the bad param.
  parseParams: ({ ss58 }) => {
    if (!isValidSs58(ss58)) throw notFound();
    return { ss58 };
  },
  // #8489: primes accountQuery -- the same query the page itself reads -- so
  // the OG card can show real activity figures instead of only a truncated
  // ss58. Shared cache, so this moves the request earlier rather than adding
  // one. Non-fatal; a failure falls back to the address-only card.
  loader: async ({ context, params }) => {
    try {
      const { data } = await context.queryClient.ensureQueryData(accountQuery(params.ss58));
      return {
        eventCount:
          typeof data.event_count === "number" && Number.isFinite(data.event_count)
            ? data.event_count
            : null,
        subnetCount:
          typeof data.subnet_count === "number" && Number.isFinite(data.subnet_count)
            ? data.subnet_count
            : null,
      };
    } catch (error) {
      // #8624: only a 404 from our own API means "no such entity". Any other
      // failure keeps returning null so the page still renders and the
      // component's own query drives the error path -- marking a page noindex
      // on a transient blip would de-index real entities during an outage.
      if (isMissingEntityError(error)) throw notFound();
      return null;
    }
  },
  head: ({ params, loaderData, match }) => {
    if (isNotFoundMatch(match)) {
      return entityNotFoundMeta("Account", "No on-chain record exists for this Bittensor address.");
    }
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
    const label = resolveAddress(params.ss58).display;
    const title = `Account ${label} — Metagraphed`;
    const description = `Bittensor account ${label}: cross-subnet activity, registrations, and first-party chain-event history on Metagraphed.`;
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
        // #8489: route-owned card (server.ts skips these paths). resolveAddress
        // is reused for the label rather than a second formatting path, per the
        // issue's own requirement to not re-derive address rendering.
        ...ogImageMeta({
          title: label,
          subtitle: "Cross-subnet activity, registrations, and chain-event history.",
          eyebrow: "Account",
          stats: [
            ...(loaderData?.eventCount != null
              ? [{ label: "Events", value: formatNumber(loaderData.eventCount) }]
              : []),
            ...(loaderData?.subnetCount != null
              ? [{ label: "Subnets", value: String(loaderData.subnetCount) }]
              : []),
          ],
        }),
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
      <p className="mt-3 text-center text-13 text-ink-muted">
        Example:{" "}
        <span className="font-mono break-all text-ink-strong">
          5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY
        </span>
      </p>
    </AppShell>
  ),
  component: AccountDetailPage,
});
