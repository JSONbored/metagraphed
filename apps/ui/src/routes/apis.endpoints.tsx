import { stripDefaultSearchParams } from "@/lib/metagraphed/url-state";
import { createFileRoute } from "@tanstack/react-router";

import { z } from "zod";
import { RoutePending } from "@/components/metagraphed/primitives";
import { EndpointsPage } from "./-endpoints-page";
import { hubMeta } from "@/lib/metagraphed/hub-copy";

const endpointsSearchSchema = z.object({
  q: z.string().catch("").default(""),
  category: z
    .enum(["all", "rpc", "wss", "api", "sse", "data", "other"])
    .catch("all")
    .default("all"),
  provider: z.string().catch("").default(""),
  health: z.string().catch("").default(""),
  netuid: z.string().catch("").default(""),
  region: z.string().catch("").default(""),
  eligibility: z.string().catch("").default(""),
  // "Callable only" hides non-callable directory links (category "other") by
  // default so the table answers "what can I call?" rather than burying it
  // under reference URLs. Persisted in the URL so the view is shareable.
  callable: z.boolean().catch(true).default(true),
  sort: z
    .enum(["netuid", "kind", "provider", "region", "health", "latency", "probed"])
    .catch("netuid")
    .default("netuid"),
  order: z.enum(["asc", "desc"]).catch("asc").default("asc"),
  page: z.number().int().min(1).catch(1).default(1),
  pageSize: z.number().int().min(10).max(200).catch(25).default(25),
  view: z.enum(["table", "grid"]).catch("table").default("table"),
  // #3976: ProxyUsagePanel's 7d/30d window is URL-backed (like /explorer) so a
  // shared /endpoints link restores the same window and back/forward works.
  window: z.enum(["7d", "30d"]).catch("7d").default("7d"),
  // Deep-linkable expanded endpoint row. Empty string = collapsed.
  endpoint: z.string().catch("").default(""),
  // Comma-separated endpoint IDs selected for side-by-side comparison.
  compare: z.string().catch("").default(""),
});

export type EndpointsSearch = z.infer<typeof endpointsSearchSchema>;

export const Route = createFileRoute("/apis/endpoints")({
  validateSearch: endpointsSearchSchema,
  search: { middlewares: [stripDefaultSearchParams(endpointsSearchSchema)] },
  head: () => ({
    meta: hubMeta("/apis/endpoints"),
  }),
  pendingComponent: () => <RoutePending panels={3} />,
  component: EndpointsPage,
});
