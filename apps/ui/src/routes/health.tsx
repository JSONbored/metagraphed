import { createFileRoute } from "@tanstack/react-router";
import {
  TRAILING_WINDOWS,
  defineSearchSchema,
  enumSearch,
  stripDefaultSearchParams,
  type SearchOutput,
} from "@/lib/metagraphed/url-state";
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
const healthSearchSchema = defineSearchSchema({
  // `TRAILING_WINDOWS`, not a fourth copy of the same three strings: it is the
  // single owner of that vocabulary (validate:schema-vocabularies enforces it).
  window: enumSearch(TRAILING_WINDOWS, "7d"),
  incidents: enumSearch(["open", "all"] as const, "open"),
});

export type HealthSearch = SearchOutput<typeof healthSearchSchema>;

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
