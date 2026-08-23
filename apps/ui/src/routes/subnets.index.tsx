import { stripDefaultSearchParams } from "@/lib/metagraphed/url-state";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { tableSearchSchema } from "@/lib/metagraphed/url-state";
import { SubnetsPage } from "./-subnets-index-page";
import { hubMeta } from "@/lib/metagraphed/hub-copy";

// #8311: /domains and /leaderboards fold into this page as sections rather
// than becoming extra `view` modes -- `tableSearchSchema.view` is shared by
// four routes, so overloading it would put "Rankings" into the view state of
// /surfaces and /providers too.
// `window` comes across from /leaderboards so its boards keep their range.
export type SubnetsSearch = z.infer<typeof subnetsSearchSchema>;

export const subnetsSearchSchema = tableSearchSchema.extend({
  section: z.enum(["registry", "rankings"]).catch("registry").default("registry"),
  window: z.enum(["7d", "30d"]).catch("7d").default("7d"),
});

export const Route = createFileRoute("/subnets/")({
  validateSearch: subnetsSearchSchema,
  search: { middlewares: [stripDefaultSearchParams(subnetsSearchSchema)] },
  head: () => ({
    meta: hubMeta("/subnets"),
  }),
  component: SubnetsPage,
});
