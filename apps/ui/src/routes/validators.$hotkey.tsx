import { createFileRoute, notFound } from "@tanstack/react-router";
import { stripDefaultSearchParams } from "@/lib/metagraphed/url-state";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
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
import { formatTao } from "@/lib/metagraphed/format";
import { logoHostFrom, ogImageMeta } from "@/lib/metagraphed/og-card";
import { validatorDetailQuery } from "@/lib/metagraphed/queries";
import { ValidatorDetailPage } from "./-validators-hotkey-page";
import { QUERY_PARAMETER_ENUMS } from "@jsonbored/metagraphed";

const NOMINATOR_ENUMS = QUERY_PARAMETER_ENUMS["/api/v1/validators/{hotkey}/nominators"];

const validatorDetailSearchSchema = z.object({
  // #8251: which detail tab is active (Per-subnet performance / Nominators /
  // History) — same `tab` convention subnets.$netuid.tsx uses.
  tab: fallback(z.string(), "subnets").default("subnets"),
  // The nominators route's own published enums (#10994).
  window: fallback(z.enum(NOMINATOR_ENUMS.window), "30d").default("30d"),
  sort: fallback(z.enum(NOMINATOR_ENUMS.sort), "net_staked").default("net_staked"),
  limit: fallback(z.number().int().min(1).max(100), 20).default(20),
  offset: fallback(z.number().int().min(0), 0).default(0),
  coldkey: fallback(z.string(), "").default(""),
});

export const Route = createFileRoute("/validators/$hotkey")({
  validateSearch: zodValidator(validatorDetailSearchSchema),
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
  // (validatorDetailQuery), so head() can put real stake/subnet-count figures
  // on the OG card. Shared react-query cache means this is the request moving
  // earlier, not a second one -- the exact pattern subnets.$netuid.tsx already
  // uses. Non-fatal: any failure returns null and the card falls back to the
  // truncated-hotkey form.
  loader: async ({ context, params }) => {
    try {
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
        totalStakeTao:
          typeof data.total_stake_tao === "number" && Number.isFinite(data.total_stake_tao)
            ? data.total_stake_tao
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
          content: `Cross-subnet performance, nominators, and staking history for Bittensor validator ${label}.`,
        },
        { property: "og:title", content: `Validator ${label} — Metagraphed` },
        {
          property: "og:description",
          content: "Cross-subnet validator performance, nominators, and staking history.",
        },
        // #8489: route-owned card (server.ts skips these paths). Prefers the
        // on-chain identity name over the truncated hotkey, and shows stake +
        // reach rather than an anonymous address.
        ...ogImageMeta({
          title: loaderData?.name || label,
          subtitle: "Cross-subnet performance, nominators, and staking history.",
          eyebrow: "Validator",
          logoHost: loaderData?.logoHost ?? null,
          stats: [
            ...(loaderData?.totalStakeTao != null
              ? [{ label: "Total stake", value: formatTao(loaderData.totalStakeTao) }]
              : []),
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
