import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { AppShell } from "@/components/metagraphed/app-shell";
import { PageMasthead } from "@/components/metagraphed/primitives";
import { ApisTabs, activeApisTab } from "./-apis-hub";

/**
 * APIs hub layout (#8302, part of #8245) — one destination for the registry's
 * public-interface surface, which was split across /surfaces, /endpoints,
 * /schemas and /providers.
 *
 * The masthead and tab strip render once here rather than per page, the same
 * shape the Chain hub established (#8244).
 *
 * Provider detail (/providers/$slug) deliberately keeps its own URL — only
 * index pages consolidate.
 */
function ApisHubLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const tab = activeApisTab(pathname);

  return (
    <AppShell>
      <PageMasthead title="APIs" description={tab.blurb} pathname={pathname} live />
      <ApisTabs />
      <Outlet />
    </AppShell>
  );
}

export const Route = createFileRoute("/apis")({
  head: () => ({
    meta: [
      { title: "APIs — Metagraphed" },
      {
        name: "description",
        content:
          "Every verified public interface across Bittensor subnets — APIs, schemas, docs and dashboards, with live endpoint health and latency.",
      },
      { property: "og:title", content: "APIs — Metagraphed" },
      {
        property: "og:description",
        content:
          "Every verified public interface across Bittensor subnets — APIs, schemas, docs and dashboards, with live endpoint health and latency.",
      },
    ],
  }),
  component: ApisHubLayout,
});
