import { stripDefaultSearchParams } from "@/lib/metagraphed/url-state";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { StatusPage } from "./-status-page";

// #3977: the probe-history drill-down's date + its nested table controls are
// URL-backed so a picked date, kind/status filters, and sort survive a reload
// and are shareable — the component is explicitly named as a `/health/history/
// {date}` resource but previously kept all of this in local state. Empty `date`
// falls back to the most-recent probe day in the component.
const SURFACE_SORT_FIELDS = ["netuid", "provider", "kind", "status", "latency_ms"] as const;

export type StatusSearch = z.infer<typeof statusSearchSchema>;

export const statusSearchSchema = z.object({
  date: fallback(z.string(), "").default(""),
  kind: fallback(z.string(), "").default(""),
  status: fallback(z.string(), "").default(""),
  sort: fallback(z.enum(SURFACE_SORT_FIELDS), "status").default("status"),
  order: fallback(z.enum(["asc", "desc"]), "asc").default("asc"),
  // #3976: RecentIncidents' 7d/30d window is URL-backed (like /explorer) so a
  // shared /status link restores the same window and back/forward works.
  window: fallback(z.enum(["7d", "30d"]), "7d").default("7d"),
});

export const Route = createFileRoute("/status")({
  validateSearch: zodValidator(statusSearchSchema),
  search: { middlewares: [stripDefaultSearchParams(statusSearchSchema)] },
  head: () => ({
    meta: [
      { title: "Status — Metagraphed" },
      {
        name: "description",
        content:
          "Public system status for the metagraphed registry: plain-language uptime, recent incidents, and probe history.",
      },
      { property: "og:title", content: "Status — Metagraphed" },
      {
        property: "og:description",
        content:
          "Public system status for the metagraphed registry: plain-language uptime, recent incidents, and probe history.",
      },
    ],
  }),
  component: StatusPage,
});
