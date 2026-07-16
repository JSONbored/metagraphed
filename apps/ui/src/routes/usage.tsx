import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Suspense } from "react";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { Skeleton } from "@/components/metagraphed/states";
import { PageHero, ShareButton, ActionBar } from "@jsonbored/ui-kit";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import {
  UsageAnalyticsPanel,
  USAGE_WINDOWS,
  type UsageWindow,
} from "@/components/metagraphed/usage-analytics-panel";

const usageSearchSchema = z.object({
  window: fallback(z.enum(USAGE_WINDOWS), "7d").default("7d"),
});

export const Route = createFileRoute("/usage")({
  validateSearch: zodValidator(usageSearchSchema),
  head: () => ({
    meta: [
      { title: "Usage analytics — Metagraphed" },
      {
        name: "description",
        content:
          "Product-usage analytics for maintainers — REST-route and MCP-tool call counts with success/failure rates over a selectable window.",
      },
      { property: "og:title", content: "Usage analytics — Metagraphed" },
      {
        property: "og:description",
        content:
          "REST-route and MCP-tool traffic with success/failure rates over 24h/7d/30d — so prioritization isn't blind.",
      },
    ],
  }),
  component: UsagePage,
});

function UsagePage() {
  const { window } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const setWindow = (w: UsageWindow) =>
    navigate({
      search: (prev) => ({ ...prev, window: w }),
      resetScroll: false,
    });

  return (
    <AppShell>
      <PageHero
        eyebrow="Maintainer"
        title="Usage analytics"
        description="Which routes and MCP tools traffic actually hits, and how often they fail — the consumption side of product-usage telemetry, so prioritization isn't blind. No PostHog login required."
        actions={
          <ActionBar>
            <ShareButton bare />
          </ActionBar>
        }
      />
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-96 w-full" />}>
          <UsageAnalyticsPanel window={window} onWindowChange={setWindow} />
        </Suspense>
      </QueryErrorBoundary>
      <ApiSourceFooter paths={["/api/v1/usage"]} />
    </AppShell>
  );
}
