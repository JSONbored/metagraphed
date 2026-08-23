import { createFileRoute } from "@tanstack/react-router";
import { TRAILING_WINDOWS, stripDefaultSearchParams } from "@/lib/metagraphed/url-state";
import { z } from "zod";
import { HealthPage } from "./-health-page";

/**
 * #11625 replaced `view` and `status` with `window` and `incidents`.
 *
 * `view` named the four panels of a page that had eight -- `matrix` and
 * `freshness` pointed at components this PR deletes, and `sources` at a panel
 * the by-subnet section absorbed. `status` filtered incidents by a health
 * word; the merged page filters them by the only distinction that changes
 * what a reader can DO about one, which is whether it is still open.
 *
 * The mega-menu's Health deep links are updated to match.
 */
const healthSearchSchema = z.object({
  // `TRAILING_WINDOWS`, not a fourth copy of the same three strings: it is the
  // single owner of that vocabulary (validate:schema-vocabularies enforces it).
  window: z.enum(TRAILING_WINDOWS).catch("7d").default("7d"),
  incidents: z.enum(["open", "all"]).catch("open").default("open"),
});

export type HealthSearch = z.infer<typeof healthSearchSchema>;

export const Route = createFileRoute("/health")({
  validateSearch: healthSearchSchema,
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
