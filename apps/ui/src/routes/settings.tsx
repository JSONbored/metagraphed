import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/metagraphed/app-shell";
import { PageHero, ShareButton } from "@jsonbored/ui-kit";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { WebhookSubscriptionManager } from "@/components/metagraphed/webhook-subscription-manager";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Developer settings — Metagraphed" },
      {
        name: "description",
        content: "Create, look up, and delete change-feed webhook subscriptions.",
      },
      { property: "og:title", content: "Developer settings — Metagraphed" },
      {
        property: "og:description",
        content: "Create, look up, and delete change-feed webhook subscriptions.",
      },
    ],
  }),
  component: SettingsPage,
});

/**
 * Utility-page family treatment (#5346): sibling routes (`/schemas`, `/health`,
 * `/endpoints`, …) open with PageHero + a KPI strip. Settings previously
 * jumped straight from title into the three forms.
 */
function SettingsPage() {
  return (
    <AppShell>
      <PageHero
        eyebrow="Operations"
        title="Developer settings"
        description="Self-service webhook subscription management against the public subscription API. Nothing here is stored server-side beyond the subscription record itself — there is no account model."
        caption="settings / v1"
        actions={<ShareButton />}
        kpis={[
          { label: "Create", value: "POST", hint: "token-gated" },
          { label: "Look up", value: "GET", hint: "by id" },
          { label: "Delete", value: "DELETE", hint: "secret" },
          { label: "Accounts", value: "None", hint: "no login" },
        ]}
      />
      <WebhookSubscriptionManager />
      <ApiSourceFooter paths={["/api/v1/webhooks/subscriptions"]} />
    </AppShell>
  );
}
