import { stripDefaultSearchParams } from "@/lib/metagraphed/url-state";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
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
  section: z.enum(["registry", "rankings"]).catch("registry").default("registry"),
  window: z.enum(["7d", "30d"]).catch("7d").default("7d"),
  // #11520: the task the reader came to do. Kept on this route rather than in
  // the shared `tableSearchSchema` until a second directory adopts it —
  // `tableSearchSchema` is shared by four routes, and giving three of them a
  // mode they do not implement would put a dead control in their URLs.
  // `browse` is the default and is stripped from the URL, so existing deep
  // links keep working unchanged and land on the focused view.
  mode: z.enum(["browse", "research", "compare"]).catch("browse").default("browse"),
});

export const Route = createFileRoute("/subnets/")({
  validateSearch: subnetsSearchSchema,
  search: { middlewares: [stripDefaultSearchParams(subnetsSearchSchema)] },
  head: () => ({
    meta: hubMeta("/subnets"),
  }),
  component: SubnetsPage,
});
