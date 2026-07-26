import type {
  ChainIdentityChange,
  EndpointIncident,
  RuntimeTransition,
} from "@/lib/metagraphed/types";

// #8257: the digest's data model, kept out of the component so it can be
// tested against real payload shapes without standing up React Query.
//
// A note on which kinds exist. The issue listed six: new subnets, ownership
// transfers, runtime upgrades, notable stake moves, incidents, registry
// additions. Only four of those have a per-EVENT source today --
// /api/v1/chain/identity-history, /api/v1/runtime's transitions,
// /api/v1/incidents, and the registry changelog. "New subnets" and "notable
// stake moves" are only published as per-subnet AGGREGATES
// (/api/v1/chain/registrations returns counts per netuid for a window, not
// individual registrations), and deriving discrete events by differencing
// aggregates would invent timestamps the API never asserted. So they're
// absent rather than approximated.

export type DigestKind = "registry" | "incident" | "identity" | "runtime";

export const DIGEST_KIND_LABEL: Record<DigestKind, string> = {
  registry: "Registry",
  incident: "Incidents",
  identity: "Identity",
  runtime: "Runtime",
};

export interface DigestItem {
  id: string;
  kind: DigestKind;
  title: string;
  detail?: string;
  /** ISO timestamp; items without one are dropped rather than bucketed as "today". */
  at: string;
  ts: number;
  tone: "default" | "accent" | "warn" | "down";
  /** In-app deep link. Absent when the event has no page of its own. */
  href?: { to: string; params?: Record<string, string> };
}

export interface DigestDay {
  /** YYYY-MM-DD in the viewer's locale, the key the group is bucketed by. */
  day: string;
  items: DigestItem[];
}

/** Local-day key. Grouping by UTC would put an evening event on "tomorrow". */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export interface DigestSources {
  changelog: Array<{ id: string; title?: string; kind?: string; at?: string }>;
  incidents: EndpointIncident[];
  identity: ChainIdentityChange[];
  runtime: RuntimeTransition[];
}

/**
 * Flattens the four sources into one newest-first list, dropping anything
 * outside `cutoff` and anything with no parseable timestamp -- an item with no
 * time can't be placed on a day, and guessing would put it under today's
 * heading as if it just happened.
 */
export function buildDigestItems(sources: DigestSources, cutoffMs: number): DigestItem[] {
  const out: DigestItem[] = [];

  for (const c of sources.changelog) {
    if (!c.at) continue;
    const ts = Date.parse(c.at);
    if (!Number.isFinite(ts)) continue;
    const k = (c.kind ?? "").toLowerCase();
    out.push({
      id: `registry:${c.id}`,
      kind: "registry",
      title: c.title || c.id,
      detail: k || "registry update",
      at: c.at,
      ts,
      tone: k.includes("adapter") ? "accent" : "default",
    });
  }

  for (const inc of sources.incidents) {
    if (!inc.started_at) continue;
    const ts = Date.parse(inc.started_at);
    if (!Number.isFinite(ts)) continue;
    const ongoing = !inc.ended_at;
    const state = String(inc.state ?? "down");
    out.push({
      id: `incident:${inc.id}`,
      kind: "incident",
      title: inc.message || `Endpoint ${inc.endpoint_id ?? ""} ${state}`,
      detail: ongoing ? "ongoing" : `resolved · ${state}`,
      at: inc.started_at,
      ts,
      tone: state === "warn" ? "warn" : "down",
    });
  }

  for (const ch of sources.identity) {
    if (!ch.observed_at) continue;
    const ts = Date.parse(ch.observed_at);
    if (!Number.isFinite(ts)) continue;
    out.push({
      id: `identity:${ch.netuid}:${ch.block_number ?? ts}`,
      kind: "identity",
      title: `${ch.subnet_name || `SN${ch.netuid}`} updated its on-chain identity`,
      detail: ch.block_number != null ? `block #${ch.block_number}` : undefined,
      at: ch.observed_at,
      ts,
      tone: "accent",
      href: { to: "/subnets/$netuid", params: { netuid: String(ch.netuid) } },
    });
  }

  for (const t of sources.runtime) {
    if (!t.observed_at) continue;
    const ts = Date.parse(t.observed_at);
    if (!Number.isFinite(ts)) continue;
    out.push({
      id: `runtime:${t.spec_version ?? ts}`,
      kind: "runtime",
      title: `Runtime upgraded to spec ${t.spec_version ?? "?"}`,
      detail: t.block_number != null ? `block #${t.block_number}` : undefined,
      at: t.observed_at,
      ts,
      tone: "accent",
      href: { to: "/chain/runtime" },
    });
  }

  return out.filter((x) => x.ts >= cutoffMs).sort((a, b) => b.ts - a.ts);
}

/** Groups an already-sorted list into day buckets, preserving newest-first order. */
export function groupByDay(items: DigestItem[]): DigestDay[] {
  const days: DigestDay[] = [];
  for (const item of items) {
    const key = dayKey(item.at);
    const last = days[days.length - 1];
    if (last && last.day === key) last.items.push(item);
    else days.push({ day: key, items: [item] });
  }
  return days;
}

/** Per-kind counts over the unfiltered set, so a chip can show what it'd reveal. */
export function countByKind(items: DigestItem[]): Record<DigestKind, number> {
  const counts: Record<DigestKind, number> = {
    registry: 0,
    incident: 0,
    identity: 0,
    runtime: 0,
  };
  for (const i of items) counts[i.kind] += 1;
  return counts;
}
