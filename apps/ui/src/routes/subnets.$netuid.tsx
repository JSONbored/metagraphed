import { createFileRoute, notFound } from "@tanstack/react-router";
import { AppShell } from "@/components/metagraphed/app-shell";
import { EmptyState, PageHeading } from "@/components/metagraphed/states";
import { subnetProfileQuery } from "@/lib/metagraphed/queries";
import { formatTao } from "@/lib/metagraphed/format";
import { ogImageMeta } from "@/lib/metagraphed/og-card";
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
      const { data } = await context.queryClient.ensureQueryData(subnetProfileQuery(params.netuid));
      return {
        name: data.name ?? null,
        health: data.health ?? null,
        // #8489: the OG card's primary stat. Alpha price is the one figure a
        // reader most wants at a glance on a shared subnet link, and it's
        // already on the profile this loader reads -- no extra request.
        // Coerced explicitly: the profile's field is loosely typed here, and
        // an uncoerced value would reach formatTao as a non-number.
        alphaPriceTao:
          typeof data.alpha_price_tao === "number" && Number.isFinite(data.alpha_price_tao)
            ? data.alpha_price_tao
            : null,
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
          stats: [
            { label: "Netuid", value: `SN${params.netuid}` },
            ...(loaderData?.alphaPriceTao != null
              ? [{ label: "Alpha price", value: formatTao(loaderData.alphaPriceTao) }]
              : health
                ? [{ label: "Health", value: health }]
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
