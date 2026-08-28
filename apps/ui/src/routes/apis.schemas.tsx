import { createFileRoute } from "@tanstack/react-router";
import {
  defineSearchSchema,
  enumSearch,
  stripDefaultSearchParams,
  stringSearch,
} from "@/lib/metagraphed/url-state";
import { SchemasPage } from "./-schemas-page";
import { hubMeta } from "@/lib/metagraphed/hub-copy";

const schemasSearchSchema = defineSearchSchema({
  drift: enumSearch(["all", "drift", "stable"] as const, "all"),
  q: stringSearch(),
  open: stringSearch(),
  driftDetail: stringSearch(),
});

export const Route = createFileRoute("/apis/schemas")({
  validateSearch: schemasSearchSchema,
  search: { middlewares: [stripDefaultSearchParams(schemasSearchSchema)] },
  head: () => ({
    meta: hubMeta("/apis/schemas"),
  }),
  component: SchemasPage,
});
