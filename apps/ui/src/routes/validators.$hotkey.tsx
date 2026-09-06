import { createFileRoute, notFound } from "@tanstack/react-router";
import {
  TRAILING_WINDOWS,
  defineSearchSchema,
  enumSearch,
  stripDefaultSearchParams,
  type SearchOutput,
} from "@/lib/metagraphed/url-state";
import { AppShell } from "@/components/metagraphed/app-shell";
import { EmptyState, PageHeading } from "@/components/metagraphed/states";
import { isValidSs58 } from "@/lib/metagraphed/accounts";
import { resolveAddress } from "@/lib/metagraphed/resolve-address";
import {
  entityNotFoundMeta,
  isMissingEntityError,
  isNotFoundMatch,
} from "@/lib/metagraphed/entity-not-found-meta";
import { recordModifiedAt } from "@/lib/metagraphed/freshness";
import { stringifyJsonLd, validatorDatasetJsonLd } from "@/lib/metagraphed/json-ld";
import { logoHostFrom, ogImageMeta } from "@/lib/metagraphed/og-card";
import { ValidatorDetailPage } from "./-validators-hotkey-page";

/**
 * One key: the window the Momentum section plots.
 *
 * The tab strip and the nominator sort/limit/offset controls went with the UI
 * that read them (#11617) -- the nominators are a rail with one disclosure
 * now, and the three tabs are three sections on one page. `validateSearch`
 * REPLACES the search object, so an unread key is dropped on the next parse.
 */
const validatorDetailSearchSchema = defineSearchSchema({
  window: enumSearch(TRAILING_WINDOWS, "30d"),
});

export type ValidatorDetailSearch = SearchOutput<typeof validatorDetailSearchSchema>;

export const Route = createFileRoute("/validators/$hotkey")({
  validateSearch: validatorDetailSearchSchema,
  search: { middlewares: [stripDefaultSearchParams(validatorDetailSearchSchema)] },
  // #6429: validate the hotkey at the router level, matching blocks.$ref.tsx
  // (#3422) and subnets.$netuid.tsx. parseParams runs before head()/the loader,
  // so an invalid hotkey renders the real not-found boundary instead of a
  // fully-formed page whose metadata interpolates the bad param.
  parseParams: ({ hotkey }) => {
    if (!isValidSs58(hotkey)) throw notFound();
    return { hotkey };
  },
  // #8489: primes the SAME query the page's own useSuspenseQuery reads
  // (validatorDetailQuery), so head() can share declared identity and observed
  // subnet membership with the OG card. Shared react-query cache means this is the request moving
  // earlier, not a second one -- the exact pattern subnets.$netuid.tsx already
  // uses. Non-fatal: any failure returns null and the card falls back to the
  // truncated-hotkey form.
  loader: async ({ context, params }) => {
    try {
      const { validatorDetailQuery } = await import("@/lib/metagraphed/queries");
      const { data, meta } = await context.queryClient.ensureQueryData(
        validatorDetailQuery(params.hotkey),
      );
      const identity = data.coldkey_identity;
      return {
        // #11313: same publish timestamp the subnet and provider records use.
        dateModified: recordModifiedAt(meta) ?? null,
        name: identity?.name ?? null,
        // Same candidate ladder the site's BrandIcon uses for a validator.
        logoHost: logoHostFrom(identity?.image, identity?.url, identity?.github),
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
      return entityNotFoundMeta(
        "Validator",
        "No Bittensor validator is registered at this hotkey.",
      );
    }
    // See accounts.$ss58.tsx: parseParams rejects a malformed hotkey, but head()
    // still runs with the raw param (the already-validating /blocks and /subnets
    // routes title invalid ids the same way today), so the not-found metadata is
    // guarded here too (#6429).
    if (!isValidSs58(params.hotkey)) {
      return entityNotFoundMeta(
        "Validator",
        "This validator identifier is not a valid Bittensor ss58 hotkey.",
      );
    }
    const label = resolveAddress(params.hotkey).display;
    return {
      meta: [
        { title: `Validator ${label} — Metagraphed` },
        {
          name: "description",
          content: `Declared identity and observed subnet memberships for Bittensor validator hotkey ${label}.`,
        },
        { property: "og:title", content: `Validator ${label} — Metagraphed` },
        {
          property: "og:description",
          content: "Declared validator identity and observed subnet memberships.",
        },
        // #8489: route-owned card (server.ts skips these paths). Prefers the
        // declared identity name over the truncated hotkey, with the observed
        // subnet count from the existing page query.
        ...ogImageMeta({
          title: loaderData?.name || label,
          subtitle: "Declared validator identity and observed subnet memberships.",
          eyebrow: "Validator",
          logoHost: loaderData?.logoHost ?? null,
          stats: [
            ...(loaderData?.subnetCount != null
              ? [{ label: "Subnets", value: String(loaderData.subnetCount) }]
              : []),
          ],
        }),
      ],
      // #11313: these are 1,023 URLs -- 53% of the sitemap -- and every one of
      // them carried a BreadcrumbList and nothing else. No node saying what the
      // page is about, no link to the machine-readable form, no place in the
      // catalog. The largest structured-data gap on the site, missed because
      // #11230's audit sampled subnets and providers.
      //
      // Emitted only on the resolved path: a Dataset built for a hotkey that is
      // not a validator would assert a record that does not exist, which is the
      // same reason the feed links and the OG card are withheld there.
      scripts: [
        {
          type: "application/ld+json",
          children: stringifyJsonLd(
            validatorDatasetJsonLd({
              hotkey: params.hotkey,
              name: loaderData?.name ?? null,
              subnetCount: loaderData?.subnetCount ?? null,
              dateModified: loaderData?.dateModified ?? null,
            }),
          ),
        },
      ],
    };
  },
  notFoundComponent: () => (
    <AppShell>
      <PageHeading
        eyebrow="Explorer"
        title="Validator not found"
        description="No registered validator matches this hotkey."
      />
      {/* #11204: serves both causes now -- a malformed hotkey, and a valid ss58
          the API confirms names no validator. In practice the second is rare:
          /api/v1/validators/{hotkey} answers 200-with-zeros for an unregistered
          hotkey rather than 404, and zeros are NOT absence under this repo's
          own contract rule, so nothing here infers one from the other. */}
      <EmptyState
        title="Validator not found"
        description="No Bittensor validator is registered at this hotkey. Hotkeys are ss58 (base58) strings — check for a truncated address, or browse the directory to find an active validator."
        action={{ label: "Back to validators", href: "/validators" }}
      />
    </AppShell>
  ),
  component: ValidatorDetailPage,
});
