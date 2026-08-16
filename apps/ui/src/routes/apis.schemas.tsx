import { createFileRoute } from "@tanstack/react-router";
import { stripDefaultSearchParams } from "@/lib/metagraphed/url-state";
import { z } from "zod";
import { SchemasPage } from "./-schemas-page";
import { hubMeta } from "@/lib/metagraphed/hub-copy";

const schemasSearchSchema = z.object({
  drift: z.enum(["all", "drift", "stable"]).catch("all").default("all"),
  q: z.string().catch("").default(""),
  open: z.string().catch("").default(""),
  driftDetail: z.string().catch("").default(""),
});

export const Route = createFileRoute("/apis/schemas")({
  validateSearch: schemasSearchSchema,
  search: { middlewares: [stripDefaultSearchParams(schemasSearchSchema)] },
  head: () => ({
    meta: hubMeta("/apis/schemas"),
  }),
  component: SchemasPage,
});
