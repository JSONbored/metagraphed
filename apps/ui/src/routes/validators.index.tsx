import { createFileRoute } from "@tanstack/react-router";
import {
  booleanSearch,
  defineSearchSchema,
  enumSearch,
  numberSearch,
  stripDefaultSearchParams,
  stringSearch,
  type SearchOutput,
} from "@/lib/metagraphed/url-state";
import { ValidatorsPage } from "./-validators-index-page";
import { hubMeta } from "@/lib/metagraphed/hub-copy";

/** Search and supported directory controls are shareable. The legacy balance
 * parameter remains readable so saved links can explain its unavailable state. */
export const validatorsSearchSchema = defineSearchSchema({
  q: stringSearch(),
  minStake: numberSearch(0),
  named: booleanSearch(false),
  sort: enumSearch(["name", "keys", "take", "memberships"] as const, "name"),
  order: enumSearch(["asc", "desc"] as const, "asc"),
});

export type ValidatorsSearch = SearchOutput<typeof validatorsSearchSchema>;

export const Route = createFileRoute("/validators/")({
  validateSearch: validatorsSearchSchema,
  search: { middlewares: [stripDefaultSearchParams(validatorsSearchSchema)] },
  head: () => ({ meta: hubMeta("/validators") }),
  component: ValidatorsPage,
});
