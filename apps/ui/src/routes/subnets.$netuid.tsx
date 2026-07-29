import { createFileRoute, notFound } from "@tanstack/react-router";
import { AppShell } from "@/components/metagraphed/app-shell";
import { EmptyState, PageHeading } from "@/components/metagraphed/states";
import { economicsQuery, subnetProfileQuery } from "@/lib/metagraphed/queries";
import { formatTao } from "@/lib/metagraphed/format";
import { logoHostFrom, ogImageMeta } from "@/lib/metagraphed/og-card";
import { SubnetDetailPage } from "./-subnets-netuid-page";

export type SearchParams = {
  tab?: string;
  sev?: string;
  uid?: number;
  ev_kind?: string;
  window?: "7d" | "30d" | "90d";
};

export const Route = createFileRoute("/subnets/$netuid")({
  validateSearch: (s: Record<string, unknown>): SearchParams => {
    const uidNum = Number(s.uid);
    const win = s.window;
    return {
      tab: typeof s.tab === "string" ? s.tab : undefined,
      sev: typeof s.sev === "string" ? s.sev : undefined,
      uid: Number.isInteger(uidNum) && uidNum >= 0 ? uidNum : undefined,
      ev_kind: typeof s.ev_kind === "string" && s.ev_kind ? s.ev_kind : undefined,
      window: win === "7d" || win === "30d" || win === "90d" ? win : undefined,
    };
  },
  parseParams: ({ netuid }) => {
    const n = Number(netuid);
    if (!Number.isFinite(n) || n < 0) throw notFound();
    return { netuid: n };
  },
  stringifyParams: ({ netuid }) => ({ netuid: String(netuid) }),
  // Prime the same query the page uses (shared cache → no double fetch) so head()
  // can build a richer OG/social card from the live subnet name + health. Non-
  // fatal: any failure returns null, head() falls back to the netuid-only copy,
  // and the page's own useSuspenseQuery still drives the error/notFound path.
  loader: async ({ context, params }) => {
    try {
      // Both queries are ones the page itself reads (SubnetMasthead uses
      // economicsQuery for its KPI band), so the shared react-query cache
      // makes this the requests moving earlier, not extra ones.
      //
      // #8489 originally read `alpha_price_tao` off the PROFILE. That field
      // does not exist there -- normalizeSubnetProfile never emits it, so the
      // price stat silently never rendered and every subnet card fell through
      // to its health string. The economics list is where the site itself gets
      // price, and it carries emission share and total stake alongside.
      const [{ data }, econRes] = await Promise.all([
        context.queryClient.ensureQueryData(subnetProfileQuery(params.netuid)),
        context.queryClient.ensureQueryData(economicsQuery()).catch(() => null),
      ]);
      const econ = econRes?.data.find((row) => row.netuid === params.netuid);
      const num = (value: unknown): number | null =>
        typeof value === "number" && Number.isFinite(value) ? value : null;
      return {
        name: data.name ?? null,
        health: data.health ?? null,
        // #8489: whichever of these resolves first is the host the site's own
        // BrandIcon would use for this subnet.
        iconUrl: (data.icon_url ?? null) as string | { light?: string; dark?: string } | null,
        website: (data.website ?? null) as string | null,
        // The three facts the subnet masthead's own KPI band leads with
        // (#8247: price, emission share, total stake) -- the same ranking,
        // applied to the card that travels.
        alphaPriceTao: num(econ?.alpha_price_tao),
        emissionShare: num(econ?.emission_share),
        totalStakeTao: num(econ?.total_stake_tao),
      };
    } catch {
      return null;
    }
  },
  head: ({ params, loaderData }) => {
    const title = loaderData?.name
      ? `${loaderData.name} (Subnet ${params.netuid}) — Metagraphed`
      : `Subnet ${params.netuid} — Metagraphed`;
    const health = loaderData?.health && loaderData.health !== "unknown" ? loaderData.health : null;
    const description = loaderData?.name
      ? `${loaderData.name}: Bittensor subnet ${params.netuid} — interfaces, endpoints, schemas${
          health ? ` and live health (${health})` : ""
        }, machine-readable on Metagraphed.`
      : `Public-interface registry for Bittensor subnet ${params.netuid}: surfaces, endpoints, schemas, health.`;
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
        // #8489: this route owns its own og:image (src/server.ts skips the
        // paths routeOwnsOgImage matches) so the card can carry the subnet's
        // real name, price and health rather than just its netuid.
        ...ogImageMeta({
          title: loaderData?.name || `Subnet ${params.netuid}`,
          subtitle: description,
          eyebrow: "Subnet",
          logoHost: logoHostFrom(loaderData?.iconUrl, loaderData?.website),
          // The health state colours the card's footer dot instead of
          // spending a whole stat cell on a one-word string.
          status: loaderData?.health ?? null,
          // Netuid always leads (it is the subnet's identity, and the one fact
          // that is never missing), then price, emission share and total stake
          // in the KPI band's own order -- capped at three by the renderer, so
          // whichever of the three resolve fill the rail left to right.
          stats: [
            { label: "Netuid", value: `SN${params.netuid}` },
            ...(loaderData?.alphaPriceTao != null
              ? [{ label: "Price", value: formatTao(loaderData.alphaPriceTao) }]
              : []),
            ...(loaderData?.emissionShare != null
              ? [
                  {
                    label: "Emission",
                    value: `${(loaderData.emissionShare * 100).toFixed(2)}%`,
                  },
                ]
              : []),
            ...(loaderData?.totalStakeTao != null
              ? [{ label: "Total stake", value: formatTao(loaderData.totalStakeTao) }]
              : []),
          ],
        }),
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
