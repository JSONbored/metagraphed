import { stripDefaultSearchParams } from "@/lib/metagraphed/url-state";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { tableSearchSchema } from "@/lib/metagraphed/url-state";
import { SubnetsPage } from "./-subnets-index-page";
import { hubMeta } from "@/lib/metagraphed/hub-copy";

// #8311: /domains and /leaderboards fold into this page as sections rather
// than becoming extra `view` modes -- `tableSearchSchema.view` is shared by
// four routes and drives <ViewModeToggle>, so overloading it would put
// "Rankings" in the table/grid/matrix toggle on /surfaces and /providers too.
// `window` comes across from /leaderboards so its boards keep their range.
export type SubnetsSearch = z.infer<typeof subnetsSearchSchema>;

export const subnetsSearchSchema = tableSearchSchema.extend({
  section: fallback(z.enum(["registry", "rankings"]), "registry").default("registry"),
  window: fallback(z.enum(["7d", "30d"]), "7d").default("7d"),
});

export const Route = createFileRoute("/subnets/")({
  validateSearch: zodValidator(subnetsSearchSchema),
  search: { middlewares: [stripDefaultSearchParams(subnetsSearchSchema)] },
  head: () => ({
    meta: hubMeta("/subnets"),
  }),
  component: SubnetsPage,
});
