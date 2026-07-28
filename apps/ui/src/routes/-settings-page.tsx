import { AppShell } from "@/components/metagraphed/app-shell";
import { PageMasthead } from "@/components/metagraphed/primitives";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { WebhookSubscriptionManager } from "@/components/metagraphed/webhook-subscription-manager";
import { ApiKeysManager } from "@/components/metagraphed/api-keys-manager";
import { AlertsManager } from "@/components/metagraphed/alerts-manager";
import { WatchlistPortability } from "@/components/metagraphed/watchlist-portability";
import { InstallAppRow } from "@/components/metagraphed/install-app-row";
import { buildSettingsHeroKpis } from "@/lib/metagraphed/settings-summary";

export function SettingsPage() {
  const kpis = buildSettingsHeroKpis();
  return (
    <AppShell>
      <PageMasthead
        eyebrow="Developer"
        live
        title="Developer settings"
        description="Your watchlist's export/import, self-service webhook subscription management against the public subscription API (no account model), wallet-connected API key management for gated fullnode access, and your own verified chain alert triggers."
        caption={<>webhooks / v1</>}
        kpis={kpis}
      />
      {/* #8384: install affordance renders nothing when there's nothing to
          offer (already installed, dismissed, unsupported browser). */}
      <InstallAppRow />
      {/* #8256: no account model means stars live in one browser. A JSON
          file is the whole portability story -- no server, no sync. */}
      <WatchlistPortability />
      <ApiKeysManager />
      <AlertsManager />
      <WebhookSubscriptionManager />
      <ApiSourceFooter
        paths={["/api/v1/webhooks/subscriptions", "/api/v1/keys", "/api/v1/watch/triggers"]}
      />
    </AppShell>
  );
}
