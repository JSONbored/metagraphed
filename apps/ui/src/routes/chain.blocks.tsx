import {
  defineSearchSchema,
  numberSearch,
  stripDefaultSearchParams,
  stringSearch,
  type SearchOutput,
} from "@/lib/metagraphed/url-state";
import { createFileRoute } from "@tanstack/react-router";
import { BlocksPage } from "./-chain-stream-page";

const blocksSearchSchema = defineSearchSchema({
  limit: numberSearch(50, { integer: true, min: 1, max: 100 }),
  offset: numberSearch(0, { integer: true, min: 0 }),
  // Server-side filters wired to the /api/v1/blocks conjunctive set.
  author: stringSearch(),
  spec_version: stringSearch(),
  block_start: stringSearch(),
  block_end: stringSearch(),
  min_extrinsics: stringSearch(),
  min_events: stringSearch(),
});

export type BlocksSearch = SearchOutput<typeof blocksSearchSchema>;

export const Route = createFileRoute("/chain/blocks")({
  validateSearch: blocksSearchSchema,
  search: { middlewares: [stripDefaultSearchParams(blocksSearchSchema)] },
  head: () => ({
    meta: [
      { title: "Blocks — Metagraphed" },
      {
        name: "description",
        content:
          "Recent Bittensor blocks indexed from the chain — block number, hash, author, extrinsic and event counts, newest first.",
      },
      { property: "og:title", content: "Blocks — Metagraphed" },
      {
        property: "og:description",
        content:
          "Recent Bittensor blocks indexed from the chain — block number, hash, author, extrinsic and event counts, newest first.",
      },
    ],
  }),
  component: BlocksPage,
});
