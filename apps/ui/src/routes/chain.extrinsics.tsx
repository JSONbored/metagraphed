import { stripDefaultSearchParams } from "@/lib/metagraphed/url-state";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { ExtrinsicsPage } from "./-extrinsics-index-page";

const extrinsicsSearchSchema = z.object({
  limit: fallback(z.number().int().min(1).max(100), 50).default(50),
  offset: fallback(z.number().int().min(0), 0).default(0),
  // Server-side filters (#265) wired to the /api/v1/extrinsics conjunctive set.
  signer: fallback(z.string(), "").default(""),
  call_module: fallback(z.string(), "").default(""),
  call_function: fallback(z.string(), "").default(""),
  success: fallback(z.enum(["", "true", "false"]), "").default(""),
});

export type ExtrinsicsSearch = z.infer<typeof extrinsicsSearchSchema>;

export const Route = createFileRoute("/chain/extrinsics")({
  validateSearch: zodValidator(extrinsicsSearchSchema),
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
