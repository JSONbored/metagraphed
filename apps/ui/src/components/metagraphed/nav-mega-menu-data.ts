import { Boxes, Layers, Network, ShieldCheck, Workflow, type LucideIcon } from "lucide-react";

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
    blurb: "Every active Finney netuid and its curated profile.",
    apiPath: "/api/v1/subnets",
    browse: [
      { to: "/subnets", label: "All subnets", hint: "Browse every active netuid" },
      { to: "/subnets/0", label: "Root (netuid 0)", hint: "Base-layer Subtensor" },
      { to: "/subnets/7", label: "Allways · SN7", hint: "Adapter-backed pilot" },
      { to: "/subnets/74", label: "Gittensor · SN74", hint: "Adapter-backed pilot" },
    ],
    filters: [
      { to: "/subnets", search: { kind: "api" }, label: "Has APIs" },
      { to: "/subnets", search: { kind: "docs" }, label: "Has docs" },
      { to: "/subnets", search: { stale: "1" }, label: "Stale > 24h" },
    ],
  },
  {
    key: "validators",
    to: "/validators",
    label: "Validators",
    icon: ShieldCheck,
    blurb: "Hotkeys ranked across every subnet, computed from the live metagraph.",
    apiPath: "/api/v1/validators",
    browse: [
      { to: "/validators", label: "All validators", hint: "Ranked by active subnets" },
      { to: "/validators", search: { sort: "total_stake" }, label: "By stake" },
      { to: "/validators", search: { sort: "nominators" }, label: "By nominators" },
    ],
    filters: [],
  },
  {
    key: "chain",
    to: "/chain",
    label: "Chain",
    icon: Boxes,
    blurb: "Blocks, transactions, events, governance and runtime — indexed chain-direct.",
    apiPath: "/api/v1/blocks",
    browse: [
      { to: "/chain", label: "Overview", hint: "Activity, fees, call mix" },
      { to: "/chain/blocks", label: "Blocks", hint: "Newest first" },
      { to: "/chain/extrinsics", label: "Extrinsics", hint: "Transactions" },
      { to: "/chain/events", label: "Events", hint: "Individual pallet events" },
      { to: "/chain/governance", label: "Governance", hint: "Sudo + AdminUtils" },
      { to: "/chain/runtime", label: "Runtime", hint: "Spec-version history" },
    ],
    filters: [],
  },
  {
    key: "accounts",
    to: "/accounts",
    label: "Accounts",
    icon: Network,
    blurb: "Hotkey and coldkey lookup, balances, positions and on-chain activity.",
    apiPath: "/api/v1/accounts",
    browse: [
      { to: "/accounts", label: "Account lookup", hint: "By hotkey or coldkey" },
      { to: "/accounts", search: { sort: "total_stake" }, label: "Top by stake" },
    ],
    filters: [],
  },
  {
    key: "apis",
    to: "/apis",
    label: "APIs",
    icon: Workflow,
    blurb: "Every verified public interface, who runs it, and whether it is up.",
    apiPath: "/api/v1/surfaces",
    browse: [
      { to: "/apis", label: "Catalog", hint: "All verified surfaces" },
      { to: "/apis/endpoints", label: "Live endpoints", hint: "Health, latency, pools" },
      { to: "/apis/schemas", label: "Schemas", hint: "OpenAPI + drift" },
      { to: "/apis/providers", label: "Providers", hint: "Teams and operators" },
      { to: "/agents", label: "For agents", hint: "MCP, SDKs, llms.txt" },
    ],
    filters: [
      { to: "/apis", search: { kind: "openapi" }, label: "OpenAPI" },
      { to: "/apis", search: { kind: "sse" }, label: "SSE streams" },
      { to: "/apis/endpoints", search: { health: "down" }, label: "Recent incidents" },
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
