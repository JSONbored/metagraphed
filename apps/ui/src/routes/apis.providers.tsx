import { stripDefaultSearchParams } from "@/lib/metagraphed/url-state";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { RoutePending } from "@/components/metagraphed/primitives";
import { ProvidersPage } from "./-providers-index-page";

export const providerSortKeys = ["name", "surfaces", "endpoints", "subnets", "updated"] as const;
export type ProviderSortKey = (typeof providerSortKeys)[number];

export type ProvidersSearch = z.infer<typeof providersSearchSchema>;

export const providersSearchSchema = z.object({
  // #8303: the audit measured an 11,900px wall of 136 provider cards. The
  // table view already existed -- this was only ever the DEFAULT. Flipped
  // rather than rebuilt; the grid stays one toggle away.
  view: fallback(z.enum(["grid", "table"]), "table").default("table"),
  q: fallback(z.string(), "").default(""),
  kind: fallback(z.string(), "").default(""),
  // `high` is a nav shortcut for official + provider-claimed (see nav-mega-menu-data).
  authority: fallback(z.string(), "").default(""),
  sort: fallback(z.enum(providerSortKeys), "name").default("name"),
});

export const Route = createFileRoute("/apis/providers")({
  validateSearch: zodValidator(providersSearchSchema),
  search: { middlewares: [stripDefaultSearchParams(providersSearchSchema)] },
  head: () => ({
    meta: [
      { title: "Providers — Metagraphed" },
      {
        name: "description",
        content: "Subnet teams, infrastructure providers, docs registries, and resource sources.",
      },
      { property: "og:title", content: "Providers — Metagraphed" },
      {
        property: "og:description",
        content: "Subnet teams, infrastructure providers, docs registries, and resource sources.",
      },
    ],
  }),
  pendingComponent: () => <RoutePending panels={3} />,
  component: ProvidersPage,
});
