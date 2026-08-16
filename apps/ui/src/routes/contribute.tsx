import { createFileRoute } from "@tanstack/react-router";
import { stripDefaultSearchParams } from "@/lib/metagraphed/url-state";
import { z } from "zod";
import { GapsPage } from "./-gaps-page";

export const STATUS_OPTIONS = ["all", "open", "in-review", "resolved", "wont-fix"] as const;
export const TARGET_OPTIONS = [
  "all",
  "native",
  "candidate-discovered",
  "machine-verified",
  "maintainer-reviewed",
  "adapter-backed",
] as const;
export const MISSING_KINDS = [
  "docs",
  "repo",
  "openapi",
  "endpoint",
  "dashboard",
  "data",
  "sdk",
  "example",
  "rpc",
] as const;
export const SORT_OPTIONS = ["priority", "netuid", "updated"] as const;

const searchSchema = z.object({
  status: z.enum(STATUS_OPTIONS).catch("all").default("all"),
  target: z.enum(TARGET_OPTIONS).catch("all").default("all"),
  missing: z.string().catch("").default(""), // comma-separated
  q: z.string().catch("").default(""),
  sort: z.enum(SORT_OPTIONS).catch("priority").default("priority"),
});

export type ContributeSearch = z.infer<typeof searchSchema>;

export const Route = createFileRoute("/contribute")({
  validateSearch: searchSchema,
  search: { middlewares: [stripDefaultSearchParams(searchSchema)] },
  head: () => ({
    meta: [
      { title: "Contribute — Metagraphed" },
      {
        name: "description",
        content:
          "Registry gaps, profile completeness, adapter candidates, and enrichment priorities. Corrections via the public repo.",
      },
      { property: "og:title", content: "Gaps — Metagraphed" },
      {
        property: "og:description",
        content:
          "Registry gaps, profile completeness, adapter candidates, and enrichment priorities. Corrections via the public repo.",
      },
    ],
  }),
  component: GapsPage,
});
