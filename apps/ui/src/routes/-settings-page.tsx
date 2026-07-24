import { AppShell } from "@/components/metagraphed/app-shell";
import { PageMasthead } from "@/components/metagraphed/primitives";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { WebhookSubscriptionManager } from "@/components/metagraphed/webhook-subscription-manager";
import { ApiKeysManager } from "@/components/metagraphed/api-keys-manager";
import { buildSettingsHeroKpis } from "@/lib/metagraphed/settings-summary";

export function SettingsPage() {
  const kpis = buildSettingsHeroKpis();
  return (
    <AppShell>
      <PageMasthead
        eyebrow="Developer"
        live
        title="Developer settings"
        description="Self-service webhook subscription management against the public subscription API (no account model), plus wallet-connected API key management for gated fullnode access."
        caption={<>webhooks / v1</>}
        kpis={kpis}
      />
      <ApiKeysManager />
      <WebhookSubscriptionManager />
      <ApiSourceFooter paths={["/api/v1/webhooks/subscriptions", "/api/v1/keys"]} />
    </AppShell>
  );
}
