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
import { ogImageMeta } from "@/lib/metagraphed/og-card";
import { subnetOgContent } from "@/lib/metagraphed/og-entity-content";
import {
  entityNotFoundMeta,
  isMissingEntityError,
  isNotFoundMatch,
} from "@/lib/metagraphed/entity-not-found-meta";
import { recordModifiedAt } from "@/lib/metagraphed/freshness";
import { SubnetDetailPage } from "./-subnets-netuid-page";
import { subnetFeedLinks } from "@/lib/metagraphed/feed-links";
import { stringifyJsonLd, subnetDatasetJsonLd } from "@/lib/metagraphed/json-ld";
import { repoSlugFrom, SITE_ORIGIN } from "@/lib/metagraphed/seo-meta";
import { API_BASE } from "@/lib/metagraphed/config";

/**
 * The page has one control -- the momentum window -- and one URL key for it.
 *
 * The seven-tab bar, the severity filter, the metagraph UID deep link, the
 * event-kind filter and the compare drawer's peer netuid all went with the
 * UI that read them (#11612). `validateSearch` REPLACES the search object,
 * so a key that no longer has a reader is not merely unused: it is dropped
 * on the next parse, and a link that carries one is silently rewritten.
 */
export const subnetSearchSchema = defineSearchSchema({
  window: enumSearch(TRAILING_WINDOWS, "30d"),
});

export type SearchParams = SearchOutput<typeof subnetSearchSchema>;

export const Route = createFileRoute("/subnets/$netuid")({
  validateSearch: subnetSearchSchema,
  search: { middlewares: [stripDefaultSearchParams(subnetSearchSchema)] },
  parseParams: ({ netuid }) => {
    const n = Number(netuid);
    if (!Number.isFinite(n) || n < 0) throw notFound();
    return { netuid: n };
  },
  stringifyParams: ({ netuid }) => ({ netuid: String(netuid) }),
  // Prime the same query the page uses (shared cache → no double fetch) so head()
  // can build a richer OG/social card from the subnet identity. Non-
  // fatal: any failure returns null, head() falls back to the netuid-only copy,
  // and the page's own useSuspenseQuery still drives the error/notFound path.
  loader: async ({ context, params }) => {
    try {
      const { economicsQuery, subnetProfileQuery } = await import("@/lib/metagraphed/queries");
      // Both queries are ones the page itself reads (SubnetMasthead uses
      // economicsQuery for its KPI band), so the shared react-query cache
      // makes this the requests moving earlier, not extra ones.
      //
      // #8489 originally read `alpha_price_tao` off the PROFILE. That field
      // does not exist there -- normalizeSubnetProfile never emits it, so the
      // price stat silently never rendered and every subnet card fell through
      // to its health string. The economics list is where the site itself gets
      // price, and it carries emission share and total stake alongside.
      const [{ data, meta }, econRes] = await Promise.all([
        context.queryClient.ensureQueryData(subnetProfileQuery(params.netuid)),
        context.queryClient.ensureQueryData(economicsQuery({ fields: "detail" })).catch(() => null),
      ]);
      const econ = econRes?.data.find((row) => row.netuid === params.netuid);
      const num = (value: unknown): number | null =>
        typeof value === "number" && Number.isFinite(value) ? value : null;
      return {
        // #11314: the record's own publish timestamp, for dateModified and
        // <lastmod>. NOT operational_observed_at -- see recordModifiedAt.
        dateModified: recordModifiedAt(meta) ?? null,
        name: data.name ?? null,
        // #11204: the subnet's own words, for the Dataset description and the
        // meta description. Falls back inside the builder rather than here, so
        // a subnet with no description still gets a valid, honest node.
        description: data.description ?? null,
        // The repo is what the measured demand actually pastes into search --
        // GSC shows queries that are literally `github.com/<owner>/<repo>` --
        // so it belongs in the description a searcher is matched against.
        repo: data.repo ?? null,
        // #8489: whichever of these resolves first is the host the site's own
        // BrandIcon would use for this subnet.
        iconUrl: (data.icon_url ?? null) as string | { light?: string; dark?: string } | null,
        website: data.website ?? null,
        // The three facts the subnet masthead's own KPI band leads with
        // (#8247: price, emission share, total stake) -- the same ranking,
        // applied to the card that travels.
        alphaPriceTao: num(econ?.alpha_price_tao),
        emissionShare: num(econ?.emission_share),
        totalStakeAlpha: num(econ?.total_stake_alpha),
      };
    } catch (error) {
      // #8624: a 404 from our own API is the one signal that means "netuid
      // 99999 is not a subnet" rather than "the API is having a moment". Only
      // that raises the not-found boundary; every other failure keeps returning
      // null, so the page still renders and the component's own
      // useSuspenseQuery drives the error path exactly as before. Marking a
      // page noindex on a transient blip would de-index real subnets during an
      // outage.
      if (isMissingEntityError(error)) throw notFound();
      return null;
    }
  },
  head: ({ params, loaderData, match }) => {
    // #8624: /subnets/99999 used to return 200 with a confident title and no
    // robots tag -- a soft 404 on an unbounded URL space. Both the malformed
    // case (parseParams throws, but head() still runs with the raw param) and
    // the well-formed-but-absent case land here now.
    if (isNotFoundMatch(match)) {
      return entityNotFoundMeta(
        "Subnet",
        `No active Bittensor subnet is registered at netuid ${params.netuid}.`,
      );
    }
    if (!Number.isFinite(Number(params.netuid))) {
      return entityNotFoundMeta("Subnet", "This subnet identifier is not a valid netuid.");
    }
    // #11204 item 5: the title is tuned to the demand Search Console actually
    // records. The queries that already find us are subnet lookups — a pasted
    // repo URL, `subnet-95`, a bare project name — so the netuid alias `SN<n>`
    // leads (it matches both "sn38" and "subnet 38"), the project name follows,
    // and the brand goes last where a truncation costs least. The old shape,
    // "Apex (Subnet 1) — Metagraphed", buried the one token most likely to be
    // typed inside parentheses.
    const alias = `SN${params.netuid}`;
    const title = loaderData?.name
      ? `${alias} · ${loaderData.name} — API, health & economics | Metagraphed`
      : `${alias} — Bittensor subnet API, health & economics | Metagraphed`;
    // The repo slug (`owner/name`) is carried in the description because a
    // pasted-repo-URL query is matched against it, and because it is the one
    // fact that disambiguates two subnets with similar names. Appended only
    // when the registry actually holds one.
    const repoSlug = repoSlugFrom(loaderData?.repo);
    const description = loaderData?.name
      ? `${loaderData.name} (${alias}): Bittensor subnet ${params.netuid} — interfaces, endpoints, schemas and endpoint observations, machine-readable on Metagraphed.${repoSlug ? ` Source: ${repoSlug}.` : ""}`
      : `Public-interface registry for Bittensor subnet ${params.netuid} (${alias}): surfaces, endpoints, schemas, health.`;
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
        // #8489: this route owns its own og:image (src/server.ts skips the
        // paths routeOwnsOgImage matches) so the card can carry the subnet's
        // identity and supported economics from its existing queries.
        ...ogImageMeta(subnetOgContent(params.netuid, loaderData)),
      ],
      // #8703: this subnet's own feed, so pasting the page URL into a reader
      // resolves it. Deliberately only on the resolved path -- both
      // entityNotFoundMeta branches above return without links, since
      // advertising a feed for a netuid that is not a subnet would hand readers
      // a permanently empty subscription.
      links: subnetFeedLinks(params.netuid),
      // #11204 item 4: the Dataset lives HERE rather than in server.ts's
      // injected graph because it describes loader data -- the name and
      // description -- that a path-only builder cannot see. Same reason the OG
      // card moved to this route in #8489. server.ts still owns the
      // Organization/WebSite/BreadcrumbList nodes on every page, so there is
      // exactly one of each and no duplication between the two.
      scripts: [
        {
          type: "application/ld+json",
          children: stringifyJsonLd(
            subnetDatasetJsonLd({
              netuid: params.netuid,
              name: loaderData?.name ?? null,
              description: loaderData?.description ?? null,
              url: `${SITE_ORIGIN}/subnets/${params.netuid}`,
              apiUrl: `${API_BASE}/api/v1/subnets/${params.netuid}`,
              artifactUrl: `${API_BASE}/metagraph/subnets/${params.netuid}.json`,
              sameAs: loaderData?.website ?? null,
              dateModified: loaderData?.dateModified ?? null,
            }),
          ),
        },
      ],
    };
  },
  component: SubnetDetailPage,
  notFoundComponent: () => (
    <AppShell>
      <PageHeading
        title="Subnet not found"
        description="No active Finney netuid matches this URL."
      />
      <EmptyState
        title="Subnet not found"
        description="No active Finney netuid matches this URL. Browse the registry to find an active subnet."
        action={{ label: "Back to registry", href: "/subnets" }}
      />
    </AppShell>
  ),
});
