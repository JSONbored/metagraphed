import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { DomainsRollup } from "@/components/metagraphed/domains-rollup";
import { ActionBar, ShareButton } from "@jsonbored/ui-kit";
import { AsyncPanel, PageMasthead, PanelSkeleton } from "@/components/metagraphed/primitives";
import { metagraphedQueryKey } from "@/lib/metagraphed/queries";

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

function DomainsPage() {
  return (
    <AppShell>
      <PageMasthead
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
      <AsyncPanel
        context="domains"
        fallback={<PanelSkeleton height="md" />}
        retryQueryKeys={[metagraphedQueryKey("domains"), metagraphedQueryKey("subnets")]}
      >
        <DomainsRollup />
      </AsyncPanel>
      <ApiSourceFooter paths={["/api/v1/domains", "/api/v1/subnets"]} />
    </AppShell>
  );
}
