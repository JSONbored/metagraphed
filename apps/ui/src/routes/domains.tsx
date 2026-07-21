import { createFileRoute } from "@tanstack/react-router";
import { Suspense } from "react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { Skeleton } from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { DomainsRollup } from "@/components/metagraphed/domains-rollup";
import { PageHero, ActionBar, ShareButton } from "@jsonbored/ui-kit";

export const Route = createFileRoute("/domains")({
  head: () => ({
    meta: [
      { title: "Domains — Metagraphed" },
      {
        name: "description",
        content:
          "Browse Bittensor subnets by capability domain — inference, storage, compute, finance, and more — with member count, total stake, emission share, and within-domain emission concentration per domain.",
      },
      { property: "og:title", content: "Domains — Metagraphed" },
      {
        property: "og:description",
        content:
          "Browse Bittensor subnets by capability domain with real stake and emission context per domain.",
      },
    ],
  }),
  component: DomainsPage,
});

function DomainsRollupSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 8 }, (_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}

function DomainsPage() {
  return (
    <AppShell>
      <PageHero
        eyebrow="Explorer"
        live
        title="Domains"
        description="The 14-tag capability taxonomy — every domain with its member subnets, total stake, emission share, and within-domain emission concentration. Expand a domain to see its full concentration breakdown and jump to any member subnet."
        actions={
          <ActionBar>
            <ShareButton bare />
          </ActionBar>
        }
      />
      <QueryErrorBoundary>
        <Suspense fallback={<DomainsRollupSkeleton />}>
          <DomainsRollup />
        </Suspense>
      </QueryErrorBoundary>
      <ApiSourceFooter paths={["/api/v1/domains", "/api/v1/subnets"]} />
    </AppShell>
  );
}
