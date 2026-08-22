import { EntityHero, FactSentence, FactStrip, FactCell } from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { WebhookSubscriptionManager } from "@/components/metagraphed/webhook-subscription-manager";
import { ApiKeysManager } from "@/components/metagraphed/api-keys-manager";
import { AlertsManager } from "@/components/metagraphed/alerts-manager";
import { AlertTriggerLookup } from "@/components/metagraphed/alert-trigger-lookup";
import { WatchlistPortability } from "@/components/metagraphed/watchlist-portability";
import { AddressLabelPortability } from "@/components/metagraphed/address-label-portability";
import { InstallAppRow } from "@/components/metagraphed/install-app-row";
import { buildSettingsHeroKpis } from "@/lib/metagraphed/settings-summary";

export function SettingsPage() {
  const kpis = buildSettingsHeroKpis();
  return (
    <AppShell>
      <EntityHero
        name="Developer settings"
        sentence={
          <FactSentence>
            Your watchlist's export/import, self-service webhook subscription management against the
            public subscription API (no account model), wallet-connected API key management for
            gated fullnode access, and your own verified chain alert triggers.
          </FactSentence>
        }
        facts={
          <FactStrip>
            {kpis.map((k) => (
              <FactCell
                key={k.label}
                label={k.label}
                value={k.value}
                hint={typeof k.hint === "string" ? k.hint : undefined}
              />
            ))}
          </FactStrip>
        }
      />
      {/* #8384: install affordance renders nothing when there's nothing to
          offer (already installed, dismissed, unsupported browser). */}
      <InstallAppRow />
      {/* #8256: no account model means stars live in one browser. A JSON
          file is the whole portability story -- no server, no sync. */}
      <WatchlistPortability />
      {/* #8484: private, local-first labels for your own addresses —
          distinct store from the watchlist, same portability posture. */}
      <AddressLabelPortability />
      <ApiKeysManager />
      <AlertsManager />
      {/* #10300: the UI could always CREATE an alert trigger and never read one
          back, so "is it still active, and has it ever fired" had no answer.
          GET /api/v1/alerts/triggers/{id} was published and rendered nowhere. */}
      <div className="mt-6">
        <AlertTriggerLookup />
      </div>
      <WebhookSubscriptionManager />
      <ApiSourceFooter
        paths={["/api/v1/webhooks/subscriptions", "/api/v1/keys", "/api/v1/watch/triggers"]}
      />
    </AppShell>
  );
}
