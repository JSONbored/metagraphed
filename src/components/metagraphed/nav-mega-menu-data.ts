import { Activity, Boxes, Layers, Network, Server, Workflow, type LucideIcon } from "lucide-react";

export interface MegaLink {
  to: string;
  search?: Record<string, string>;
  label: string;
  hint?: string;
  external?: string;
}

export interface MegaPanel {
  key: string;
  to: string;
  label: string;
  icon: LucideIcon;
  blurb: string;
  apiPath: string;
  browse: MegaLink[];
  filters: MegaLink[];
}

export const MEGA_PANELS: MegaPanel[] = [
  {
    key: "subnets",
    to: "/subnets",
    label: "Subnets",
    icon: Layers,
    blurb: "All active Finney netuids and their curated profiles.",
    apiPath: "/api/v1/subnets",
    browse: [
      { to: "/subnets", label: "All subnets", hint: "Browse every active netuid" },
      {
        to: "/subnets",
        search: { curation: "verified" },
        label: "Curated",
        hint: "Maintainer-reviewed",
      },
      {
        to: "/subnets",
        search: { curation: "machine-verified" },
        label: "Machine-verified",
        hint: "Probed & confirmed",
      },
      { to: "/subnets/0", label: "Root (netuid 0)", hint: "Base-layer Subtensor" },
      { to: "/subnets/7", label: "Allways · SN7", hint: "Adapter-backed pilot" },
      { to: "/subnets/74", label: "Gittensor · SN74", hint: "Adapter-backed pilot" },
    ],
    filters: [
      { to: "/subnets", search: { kind: "api" }, label: "Has APIs" },
      { to: "/subnets", search: { kind: "docs" }, label: "Has docs" },
      { to: "/subnets", search: { kind: "sse" }, label: "Has SSE" },
      { to: "/subnets", search: { stale: "1" }, label: "Stale > 24h" },
    ],
  },
  {
    key: "blocks",
    to: "/blocks",
    label: "Blocks",
    icon: Boxes,
    blurb: "Recent blocks indexed directly from the chain.",
    apiPath: "/api/v1/blocks",
    browse: [
      { to: "/blocks", label: "Recent blocks", hint: "Newest first" },
      { to: "/blocks", search: { limit: "100" }, label: "100 per page" },
      { to: "/extrinsics", label: "Extrinsics", hint: "Transactions, newest first" },
      { to: "/accounts", label: "Accounts", hint: "Hotkey / coldkey lookup" },
    ],
    filters: [],
  },
  {
    key: "surfaces",
    to: "/surfaces",
    label: "Surfaces",
    icon: Workflow,
    blurb: "Verified public interfaces across subnets.",
    apiPath: "/api/v1/surfaces",
    browse: [
      { to: "/surfaces", label: "All surfaces" },
      { to: "/surfaces", search: { kind: "openapi" }, label: "OpenAPI" },
      { to: "/surfaces", search: { kind: "docs" }, label: "Docs" },
      { to: "/surfaces", search: { kind: "dashboard" }, label: "Dashboards" },
      { to: "/surfaces", search: { kind: "data" }, label: "Data artifacts" },
      { to: "/surfaces", search: { kind: "sse" }, label: "SSE streams" },
    ],
    filters: [
      { to: "/surfaces", search: { public_safe: "1" }, label: "Public-safe only" },
      { to: "/surfaces", search: { auth: "required" }, label: "Auth required" },
      { to: "/surfaces", search: { rate_limited: "1" }, label: "Rate-limited" },
    ],
  },
  {
    key: "endpoints",
    to: "/endpoints",
    label: "Endpoints",
    icon: Server,
    blurb: "Root RPC/WSS plus generalized endpoint resources.",
    apiPath: "/api/v1/endpoints",
    browse: [
      { to: "/endpoints", label: "All endpoints" },
      { to: "/endpoints", search: { kind: "rpc" }, label: "Root RPC" },
      { to: "/endpoints", search: { kind: "wss" }, label: "WSS" },
      { to: "/endpoints", search: { archive: "1" }, label: "Archive-capable" },
      { to: "/endpoints", search: { pool: "eligible" }, label: "Pool-eligible" },
    ],
    filters: [
      { to: "/endpoints", search: { incidents: "recent" }, label: "Recent incidents" },
      { to: "/endpoints", search: { stale: "1" }, label: "Stale probes" },
    ],
  },
  {
    key: "providers",
    to: "/providers",
    label: "Providers",
    icon: Network,
    blurb: "Subnet teams, infra providers, and docs registries.",
    apiPath: "/api/v1/providers",
    browse: [
      { to: "/providers", label: "All providers" },
      { to: "/providers", search: { kind: "subnet-team" }, label: "Subnet teams" },
      { to: "/providers", search: { kind: "infra" }, label: "Infra providers" },
      { to: "/providers", search: { kind: "docs" }, label: "Docs registries" },
    ],
    filters: [
      { to: "/providers", search: { authority: "high" }, label: "Authority high" },
      { to: "/providers", search: { sort: "updated" }, label: "Recently updated" },
    ],
  },
  {
    key: "health",
    to: "/health",
    label: "Health",
    icon: Activity,
    blurb: "Probe-derived freshness and incident state.",
    apiPath: "/api/v1/health",
    browse: [
      { to: "/health", label: "Overview" },
      { to: "/health", search: { view: "matrix" }, label: "Subnet matrix" },
      { to: "/health", search: { view: "incidents" }, label: "Incidents" },
      { to: "/health", search: { view: "sources" }, label: "Source health" },
      { to: "/health", search: { view: "freshness" }, label: "Freshness" },
    ],
    filters: [
      { to: "/health", search: { status: "warn" }, label: "Degraded" },
      { to: "/health", search: { status: "down" }, label: "Down" },
    ],
  },
];

const RECENT_KEY = "mg.recent-views";
const OPEN_KEY = "mg.mega-open";
const FILTER_KEY = "mg.mega-filter";

export type RecentItem = { kind: "subnet" | "provider"; to: string; label: string };

export function loadRecent(): RecentItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RecentItem[]).slice(0, 5) : [];
  } catch {
    return [];
  }
}

export function pushRecentView(item: RecentItem) {
  if (typeof window === "undefined") return;
  try {
    const cur = loadRecent().filter((r) => r.to !== item.to);
    cur.unshift(item);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(cur.slice(0, 5)));
  } catch {
    /* ignore */
  }
}

export function loadPersistedOpen(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(OPEN_KEY);
  } catch {
    return null;
  }
}
export function persistOpen(key: string | null) {
  if (typeof window === "undefined") return;
  try {
    if (key) window.sessionStorage.setItem(OPEN_KEY, key);
    else window.sessionStorage.removeItem(OPEN_KEY);
  } catch {
    /* ignore */
  }
}
export function loadFilters(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.sessionStorage.getItem(FILTER_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}
export function persistFilter(key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    const cur = loadFilters();
    if (value) cur[key] = value;
    else delete cur[key];
    window.sessionStorage.setItem(FILTER_KEY, JSON.stringify(cur));
  } catch {
    /* ignore */
  }
}
