import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { DomainsRollup } from "@/components/metagraphed/domains-rollup";
import { ActionBar, ShareButton } from "@jsonbored/ui-kit";
import { AsyncPanel, PageMasthead, PanelSkeleton } from "@/components/metagraphed/primitives";
import { metagraphedQueryKey } from "@/lib/metagraphed/queries";

export function DomainsPage() {
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
