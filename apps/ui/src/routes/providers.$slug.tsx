import { createFileRoute, notFound } from "@tanstack/react-router";
import { AppShell } from "@/components/metagraphed/app-shell";
import { EmptyState, PageHeading } from "@/components/metagraphed/states";
import { RoutePending } from "@/components/metagraphed/primitives";
import { providerQuery } from "@/lib/metagraphed/queries";
import { ProviderDetail } from "./-providers-slug-page";

type SearchParams = { tab?: string };

export const Route = createFileRoute("/providers/$slug")({
  validateSearch: (s: Record<string, unknown>): SearchParams => ({
    tab: typeof s.tab === "string" ? s.tab : undefined,
  }),
  parseParams: ({ slug }) => {
    if (!slug) throw notFound();
    return { slug };
  },
  // Prime the page's provider query (shared cache → no double fetch) so head()
  // can use the real provider name in the OG/social card. Non-fatal: falls back
  // to the slug on any failure.
  loader: async ({ context, params }) => {
    try {
      const { data } = await context.queryClient.ensureQueryData(providerQuery(params.slug));
      return { name: data.name ?? null };
    } catch {
      return null;
    }
  },
  head: ({ params, loaderData }) => {
    const name = loaderData?.name ?? params.slug;
    const title = `${name} — Provider — Metagraphed`;
    const description = `${name}: Bittensor infrastructure provider — public endpoints, operational surfaces, and live health on Metagraphed.`;
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
      ],
    };
  },
  pendingComponent: () => <RoutePending panels={3} />,
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
