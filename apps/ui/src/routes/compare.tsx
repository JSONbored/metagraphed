import { pageMeta } from "@/lib/metagraphed/seo-meta";
import { createFileRoute } from "@tanstack/react-router";
import {
  defineSearchSchema,
  enumSearch,
  stripDefaultSearchParams,
  stringSearch,
  type SearchOutput,
} from "@/lib/metagraphed/url-state";
import { ComparePage } from "./-compare-page";

/**
 * `/compare?subnets=19,1` and `/compare?validators=a,b` (#11611). The
 * comparison is a page, not a drawer: it has a URL you can send someone, and
 * the two entity kinds share one ledger.
 */
/**
 * The params stay the CSV the URL shows -- `?subnets=19,1`. Parsing them into
 * arrays inside `validateSearch` would make TanStack serialise the ARRAY back
 * out (`?subnets=%5B19%2C1%5D`) and 307 every shared link to that shape.
 */
export const compareSearchSchema = defineSearchSchema({
  // Empty means a legacy link: infer its kind from the selected entities.
  kind: enumSearch(["", "subnets", "validators"] as const, ""),
  subnets: {
    defaultValue: "",
    parse(value: unknown) {
      // TanStack JSON-parses a single netuid in legacy `?subnets=19` links.
      // Keep the validated value a CSV string, just like multi-subnet links.
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
        return String(value);
      }
      return typeof value === "string" ? value : "";
    },
  },
  validators: stringSearch(),
});

export type CompareSearch = SearchOutput<typeof compareSearchSchema>;

/** `"19,1"` → `[19, 1]`, at most three, invalid entries dropped. */
export function parseNetuids(value: string): number[] {
  return value
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((n) => Number.isInteger(n) && n >= 0)
    .slice(0, 3);
}

/** `"5A,5B"` → `["5A", "5B"]`, at most three, blanks dropped. */
export function parseHotkeys(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 3);
}

export const Route = createFileRoute("/compare")({
  validateSearch: compareSearchSchema,
  // Without this an empty `validators=` is written back into every subnet
  // comparison's URL, and the visit 307s to it.
  search: { middlewares: [stripDefaultSearchParams(compareSearchSchema)] },
  head: () => ({
    meta: pageMeta(
      "Compare — Metagraphed",
      "Compare Bittensor subnets or individual validator hotkeys, including available emissions, registrations, observed take and subnet memberships.",
    ),
  }),
  component: ComparePage,
});
