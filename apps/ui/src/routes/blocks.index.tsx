import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { BlocksPage } from "./-blocks-index-page";

const blocksSearchSchema = z.object({
  limit: fallback(z.number().int().min(1).max(100), 50).default(50),
  offset: fallback(z.number().int().min(0), 0).default(0),
  // Server-side filters wired to the /api/v1/blocks conjunctive set.
  author: fallback(z.string(), "").default(""),
  spec_version: fallback(z.string(), "").default(""),
  block_start: fallback(z.string(), "").default(""),
  block_end: fallback(z.string(), "").default(""),
  min_extrinsics: fallback(z.string(), "").default(""),
  min_events: fallback(z.string(), "").default(""),
});

export type BlocksSearch = z.infer<typeof blocksSearchSchema>;

export const Route = createFileRoute("/blocks/")({
  validateSearch: zodValidator(blocksSearchSchema),
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
