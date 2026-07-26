import { createFileRoute } from "@tanstack/react-router";

import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { RoutePending } from "@/components/metagraphed/primitives";
import { EndpointsPage } from "./-endpoints-page";

const endpointsSearchSchema = z.object({
  q: fallback(z.string(), "").default(""),
  category: fallback(z.enum(["all", "rpc", "wss", "api", "sse", "data", "other"]), "all").default(
    "all",
  ),
  provider: fallback(z.string(), "").default(""),
  health: fallback(z.string(), "").default(""),
  netuid: fallback(z.string(), "").default(""),
  region: fallback(z.string(), "").default(""),
  eligibility: fallback(z.string(), "").default(""),
  // "Callable only" hides non-callable directory links (category "other") by
  // default so the table answers "what can I call?" rather than burying it
  // under reference URLs. Persisted in the URL so the view is shareable.
  callable: fallback(z.boolean(), true).default(true),
  sort: fallback(
    z.enum(["netuid", "kind", "provider", "region", "health", "latency", "probed"]),
    "netuid",
  ).default("netuid"),
  order: fallback(z.enum(["asc", "desc"]), "asc").default("asc"),
  page: fallback(z.number().int().min(1), 1).default(1),
  pageSize: fallback(z.number().int().min(10).max(200), 25).default(25),
  view: fallback(z.enum(["table", "grid"]), "table").default("table"),
  // #3976: ProxyUsagePanel's 7d/30d window is URL-backed (like /explorer) so a
  // shared /endpoints link restores the same window and back/forward works.
  window: fallback(z.enum(["7d", "30d"]), "7d").default("7d"),
  // Deep-linkable expanded endpoint row. Empty string = collapsed.
  endpoint: fallback(z.string(), "").default(""),
  // Comma-separated endpoint IDs selected for side-by-side comparison.
  compare: fallback(z.string(), "").default(""),
});

export type EndpointsSearch = z.infer<typeof endpointsSearchSchema>;

export const Route = createFileRoute("/apis/endpoints")({
  validateSearch: zodValidator(endpointsSearchSchema),
  head: () => ({
    meta: [
      { title: "Endpoints — Metagraphed" },
      {
        name: "description",
        content:
          "Root Subtensor RPC/WSS and application endpoints with status, latency, and pool eligibility.",
      },
      { property: "og:title", content: "Endpoints — Metagraphed" },
      {
        property: "og:description",
        content:
          "Root Subtensor RPC/WSS and application endpoints with status, latency, and pool eligibility.",
      },
    ],
  }),
  pendingComponent: () => <RoutePending panels={3} />,
  component: EndpointsPage,
});
