import {
  defineSearchSchema,
  enumSearch,
  numberSearch,
  stripDefaultSearchParams,
  stringSearch,
  type SearchOutput,
} from "@/lib/metagraphed/url-state";
import { createFileRoute } from "@tanstack/react-router";
import { ExtrinsicsPage } from "./-chain-stream-page";

const extrinsicsSearchSchema = defineSearchSchema({
  limit: numberSearch(50, { integer: true, min: 1, max: 100 }),
  offset: numberSearch(0, { integer: true, min: 0 }),
  // Server-side filters (#265) wired to the /api/v1/extrinsics conjunctive set.
  signer: stringSearch(),
  call_module: stringSearch(),
  call_function: stringSearch(),
  success: enumSearch(["", "true", "false"] as const, ""),
});

export type ExtrinsicsSearch = SearchOutput<typeof extrinsicsSearchSchema>;

export const Route = createFileRoute("/chain/extrinsics")({
  validateSearch: extrinsicsSearchSchema,
  search: { middlewares: [stripDefaultSearchParams(extrinsicsSearchSchema)] },
  head: () => ({
    meta: [
      { title: "Extrinsics — Metagraphed" },
      {
        name: "description",
        content:
          "Recent Bittensor extrinsics (transactions) indexed from the chain — call, signer, success and block, newest first.",
      },
      { property: "og:title", content: "Extrinsics — Metagraphed" },
      {
        property: "og:description",
        content:
          "Recent Bittensor extrinsics (transactions) indexed from the chain — call, signer, success and block, newest first.",
      },
    ],
  }),
  component: ExtrinsicsPage,
});
