import { createFileRoute } from "@tanstack/react-router";
import { stripDefaultSearchParams } from "@/lib/metagraphed/url-state";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { HealthPage } from "./-health-page";

// Mirrors the Health mega-menu ops deep-links (nav-mega-menu-data.ts
// `MEGA_PANELS` "health" panel) so `/health?view=...` and `/health?status=...`
// scroll to a specific section/filter. Public plain-language status lives on
// `/status` (surfaced from the same panel). `status` also backs the page's own
// incident-filter chips.
const HEALTH_VIEWS = ["", "matrix", "incidents", "sources", "freshness"] as const;
export type HealthView = (typeof HEALTH_VIEWS)[number];

const HEALTH_STATUSES = ["all", "down", "warn", "resolved"] as const;
export type StateFilter = (typeof HEALTH_STATUSES)[number];

const healthSearchSchema = z.object({
  view: fallback(z.enum(HEALTH_VIEWS), "").default(""),
  status: fallback(z.enum(HEALTH_STATUSES), "all").default("all"),
});

export type HealthSearch = z.infer<typeof healthSearchSchema>;

export const Route = createFileRoute("/health")({
  validateSearch: zodValidator(healthSearchSchema),
  search: { middlewares: [stripDefaultSearchParams(healthSearchSchema)] },
  head: () => ({
    meta: [
      { title: "Health — Metagraphed" },
      {
        name: "description",
        content:
          "Operational health drill-down for maintainers: subnet matrix, endpoint mosaic, source freshness, and live incidents.",
      },
      { property: "og:title", content: "Health — Metagraphed" },
      {
        property: "og:description",
        content:
          "Operational health drill-down for maintainers: subnet matrix, endpoint mosaic, source freshness, and live incidents.",
      },
    ],
  }),
  component: HealthPage,
});
