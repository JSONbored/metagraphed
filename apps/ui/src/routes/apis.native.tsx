import { createFileRoute } from "@tanstack/react-router";
import { NativeRuntimeRoutePage } from "./-native-runtime-page";
import {
  defineSearchSchema,
  stringSearch,
  stripDefaultSearchParams,
} from "@/lib/metagraphed/url-state";

const title = "Bittensor native state and calls · Metagraphed";
const description =
  "Read finalized Bittensor protocol state, inspect runtime types and prepare unsigned native calls from the chain’s current metadata.";
const searchSchema = defineSearchSchema({ netuid: stringSearch(), coldkey: stringSearch() });

export const Route = createFileRoute("/apis/native")({
  validateSearch: searchSchema,
  search: { middlewares: [stripDefaultSearchParams(searchSchema)] },
  head: () => ({
    meta: [
      { title },
      { name: "description", content: description },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
    ],
  }),
  component: NativeRuntimeRoutePage,
});
