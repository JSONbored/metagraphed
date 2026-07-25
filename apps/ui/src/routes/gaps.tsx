import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
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
  status: fallback(z.enum(STATUS_OPTIONS), "all").default("all"),
  target: fallback(z.enum(TARGET_OPTIONS), "all").default("all"),
  missing: fallback(z.string(), "").default(""), // comma-separated
  q: fallback(z.string(), "").default(""),
  sort: fallback(z.enum(SORT_OPTIONS), "priority").default("priority"),
});

export const Route = createFileRoute("/gaps")({
  validateSearch: zodValidator(searchSchema),
  head: () => ({
    meta: [
      { title: "Gaps — Metagraphed" },
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
