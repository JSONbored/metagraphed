import { createFileRoute } from "@tanstack/react-router";
import {
  defineSearchSchema,
  stripDefaultSearchParams,
  stringSearch,
  type SearchOutput,
} from "@/lib/metagraphed/url-state";
import { GapsPage } from "./-gaps-page";

/**
 * #11626 cut this from five params to three.
 *
 * `status` and `target` filtered an enrichment queue and an attribution
 * funnel that this PR deletes -- neither maps to anything /api/v1/gaps
 * publishes. `sort` was the page's own ordering over the registry's
 * `gap_priority`, which is the curation lane's answer to "what next" and is
 * used as given now: a page that re-ranked gaps would send contributors
 * somewhere the lane did not ask them to go.
 */
const searchSchema = defineSearchSchema({
  q: stringSearch(),
  missing: stringSearch(),
  severity: stringSearch(),
});

export type ContributeSearch = SearchOutput<typeof searchSchema>;

export const Route = createFileRoute("/contribute")({
  validateSearch: searchSchema,
  search: { middlewares: [stripDefaultSearchParams(searchSchema)] },
  head: () => ({
    meta: [
      { title: "Contribute — Metagraphed" },
      {
        name: "description",
        content:
          "Registry gaps, profile completeness, adapter candidates, and enrichment priorities. Corrections via the public repo.",
      },
      { property: "og:title", content: "Contribute — Metagraphed" },
      {
        property: "og:description",
        content:
          "Registry gaps, profile completeness, adapter candidates, and enrichment priorities. Corrections via the public repo.",
      },
    ],
  }),
  component: GapsPage,
});
