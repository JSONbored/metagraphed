import { createFileRoute } from "@tanstack/react-router";
import { fallback } from "@tanstack/zod-adapter";
import { z } from "zod";
import { SchemasPage } from "./-schemas-page";

const schemasSearchSchema = z.object({
  drift: fallback(z.enum(["all", "drift", "stable"]), "all").default("all"),
  q: fallback(z.string(), "").default(""),
  open: fallback(z.string(), "").default(""),
  driftDetail: fallback(z.string(), "").default(""),
});

export const Route = createFileRoute("/apis/schemas")({
  validateSearch: schemasSearchSchema,
  head: () => ({
    meta: [
      { title: "Schemas — Metagraphed" },
      {
        name: "description",
        content:
          "OpenAPI, contracts, schema index, and drift between current and previous snapshots.",
      },
      { property: "og:title", content: "Schemas — Metagraphed" },
      {
        property: "og:description",
        content:
          "OpenAPI, contracts, schema index, and drift between current and previous snapshots.",
      },
    ],
  }),
  component: SchemasPage,
});
