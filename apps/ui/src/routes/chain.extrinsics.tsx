import { stripDefaultSearchParams } from "@/lib/metagraphed/url-state";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ExtrinsicsPage } from "./-chain-stream-page";

const extrinsicsSearchSchema = z.object({
  limit: z.number().int().min(1).max(100).catch(50).default(50),
  offset: z.number().int().min(0).catch(0).default(0),
  // Server-side filters (#265) wired to the /api/v1/extrinsics conjunctive set.
  signer: z.string().catch("").default(""),
  call_module: z.string().catch("").default(""),
  call_function: z.string().catch("").default(""),
  success: z.enum(["", "true", "false"]).catch("").default(""),
});

export type ExtrinsicsSearch = z.infer<typeof extrinsicsSearchSchema>;

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
