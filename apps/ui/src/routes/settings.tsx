import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/metagraphed/app-shell";
import { PageHero } from "@jsonbored/ui-kit";
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

function SettingsPage() {
  return (
    <AppShell>
      <PageHero
        eyebrow="Developer"
        title="Developer settings"
        description="Self-service webhook subscription management against the public subscription API. Nothing here is stored server-side beyond the subscription record itself — there is no account model."
      />
      <WebhookSubscriptionManager />
      <ApiSourceFooter paths={["/api/v1/webhooks/subscriptions"]} />
    </AppShell>
  );
}
