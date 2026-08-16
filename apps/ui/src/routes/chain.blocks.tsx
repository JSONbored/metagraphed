import { stripDefaultSearchParams } from "@/lib/metagraphed/url-state";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { BlocksPage } from "./-blocks-index-page";

const blocksSearchSchema = z.object({
  limit: z.number().int().min(1).max(100).catch(50).default(50),
  offset: z.number().int().min(0).catch(0).default(0),
  // Server-side filters wired to the /api/v1/blocks conjunctive set.
  author: z.string().catch("").default(""),
  spec_version: z.string().catch("").default(""),
  block_start: z.string().catch("").default(""),
  block_end: z.string().catch("").default(""),
  min_extrinsics: z.string().catch("").default(""),
  min_events: z.string().catch("").default(""),
});

export type BlocksSearch = z.infer<typeof blocksSearchSchema>;

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
