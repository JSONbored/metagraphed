import { createFileRoute } from "@tanstack/react-router";
import { stripDefaultSearchParams } from "@/lib/metagraphed/url-state";
import { fallback } from "@tanstack/zod-adapter";
import { z } from "zod";
import { SchemasPage } from "./-schemas-page";
import { hubMeta } from "@/lib/metagraphed/hub-copy";

const schemasSearchSchema = z.object({
  drift: fallback(z.enum(["all", "drift", "stable"]), "all").default("all"),
  q: fallback(z.string(), "").default(""),
  open: fallback(z.string(), "").default(""),
  driftDetail: fallback(z.string(), "").default(""),
});

export const Route = createFileRoute("/apis/schemas")({
  validateSearch: schemasSearchSchema,
  search: { middlewares: [stripDefaultSearchParams(schemasSearchSchema)] },
  head: () => ({
    meta: hubMeta("/apis/schemas"),
  }),
  component: SchemasPage,
});
