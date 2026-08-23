import { stripDefaultSearchParams } from "@/lib/metagraphed/url-state";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { Skeleton } from "@jsonbored/ui-kit";
import { ProvidersPage } from "./-providers-index-page";
import { hubMeta } from "@/lib/metagraphed/hub-copy";

export type ProvidersSearch = z.infer<typeof providersSearchSchema>;

/**
 * #11624 dropped `view` and `sort`.
 *
 * `view` toggled a grid of 136 provider cards that #8303 had already demoted
 * out of the default; the table is the page now and the grid is gone rather
 * than one toggle away. `sort` is the table's own, and duplicating it in the
 * URL let the two disagree.
 */
export const providersSearchSchema = z.object({
  q: z.string().catch("").default(""),
  kind: z.string().catch("").default(""),
  // `high` is a nav shortcut for official + provider-claimed (see nav-mega-menu-data).
  authority: z.string().catch("").default(""),
});

export const Route = createFileRoute("/apis/providers")({
  validateSearch: providersSearchSchema,
  search: { middlewares: [stripDefaultSearchParams(providersSearchSchema)] },
  head: () => ({
    meta: hubMeta("/apis/providers"),
  }),
  pendingComponent: () => <Skeleton className="mx-auto my-6 h-96 w-full max-w-shell" />,
  component: ProvidersPage,
});
