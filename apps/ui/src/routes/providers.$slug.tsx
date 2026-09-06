import { createFileRoute, notFound } from "@tanstack/react-router";
import { AppShell } from "@/components/metagraphed/app-shell";
import { EmptyState, PageHeading } from "@/components/metagraphed/states";
import { EntityRouteLoadingSkeleton } from "@/components/metagraphed/route-loading-skeleton";
import { ogImageMeta } from "@/lib/metagraphed/og-card";
import { providerOgContent } from "@/lib/metagraphed/og-entity-content";
import { providerDatasetJsonLd, stringifyJsonLd } from "@/lib/metagraphed/json-ld";
import { SITE_ORIGIN } from "@/lib/metagraphed/identity";
import { API_BASE } from "@/lib/metagraphed/config";
import { ProviderDetail } from "./-providers-slug-page";
import {
  entityNotFoundMeta,
  isMissingEntityError,
  isNotFoundMatch,
} from "@/lib/metagraphed/entity-not-found-meta";
import { recordModifiedAt } from "@/lib/metagraphed/freshness";

export const Route = createFileRoute("/providers/$slug")({
  // #11624 dropped the `tab` param with the tab strip: the page is three
  // sections now, and an in-page anchor is what a link to one of them is.
  parseParams: ({ slug }) => {
    if (!slug) throw notFound();
    return { slug };
  },
  // Prime the page's provider query (shared cache → no double fetch) so head()
  // can use the real provider name in the OG/social card. Non-fatal: falls back
  // to the slug on any failure.
  loader: async ({ context, params }) => {
    try {
      const { providerQuery } = await import("@/lib/metagraphed/queries");
      const { data, meta } = await context.queryClient.ensureQueryData(providerQuery(params.slug));
      return {
        // #11314: the record's publish timestamp -- see recordModifiedAt for why
        // it is not the probe observation.
        dateModified: recordModifiedAt(meta) ?? null,
        name: data.name ?? null,
        // #11204: the card's own fields. The registry curates a logo for 102 of
        // the 138 providers, and the counts are what the page's pulse tiles
        // lead with -- the same three facts, on the card that travels.
        iconUrl: data.icon_url ?? null,
        website: data.website ?? null,
        endpoints: data.endpoints_count ?? null,
        surfaces: data.surfaces_count ?? null,
        subnets: typeof data.subnet_count === "number" ? data.subnet_count : null,
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
      return entityNotFoundMeta("Provider", "No API provider matches this slug.");
    }
    const name = loaderData?.name ?? params.slug;
    const title = `${name} — Provider — Metagraphed`;
    const description = `${name}: Bittensor infrastructure provider — public endpoints, interfaces and endpoint observations on Metagraphed.`;
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
        // #11204: this route owns its own og:image (routeOwnsOgImage matches
        // it, so src/server.ts skips its pathname-derived injection). That card
        // said "404-gen" with no logo and no numbers; this one says "404-GEN",
        // shows the registry's curated logo and carries the counts.
        ...ogImageMeta(providerOgContent(params.slug, loaderData)),
      ],
      // #11204: the provider pages carried no node of their own, so 138 registry
      // records were untyped prose. Dataset, matching the subnet treatment --
      // and deliberately NOT an Organization for the provider, which would be
      // asserting a third party's identity on their behalf.
      scripts: [
        {
          type: "application/ld+json",
          children: stringifyJsonLd(
            providerDatasetJsonLd({
              slug: params.slug,
              name: loaderData?.name ?? null,
              url: `${SITE_ORIGIN}/providers/${encodeURIComponent(params.slug)}`,
              apiUrl: `${API_BASE}/api/v1/providers/${encodeURIComponent(params.slug)}`,
              artifactUrl: `${API_BASE}/metagraph/providers/${encodeURIComponent(params.slug)}.json`,
              sameAs: loaderData?.website ?? null,
              dateModified: loaderData?.dateModified ?? null,
            }),
          ),
        },
      ],
    };
  },
  pendingComponent: EntityRouteLoadingSkeleton,
  component: ProviderDetail,
  notFoundComponent: () => (
    <AppShell>
      <PageHeading title="Provider not found" />
      <EmptyState
        title="Provider not found"
        description="No provider matches this slug. Browse the provider directory to find the one you're looking for."
        action={{ label: "Back to providers", href: "/apis/providers" }}
      />
    </AppShell>
  ),
});
