/**
 * The derivations behind /accounts/$ss58 (#11614).
 *
 * Pure and API-shaped, so the five sections stay declarative and the
 * arithmetic that decides what a reader is told about someone's money is
 * testable without a DOM.
 */
import type {
  AccountCounterparty,
  AccountDelegationEdge,
  AccountEvent,
  AccountPosition,
  AccountStakeFlowSubnet,
} from "@/lib/metagraphed/types";

export type FlowWindow = "7d" | "30d" | "90d";

export const FLOW_WINDOWS = [
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
] as const;

/**
 * The scan ceiling `/accounts/{ss58}` applies before it declines to summarise.
 *
 * Above this the summary returns `event_scan_capped: true` and its counts
 * describe the scanned prefix, not the account. Rendering them as totals
 * would understate a whale by an unknown amount, so the page says so instead.
 */
export const EVENT_SCAN_CAP = 5000;

export const fmtTao = (value: number | null | undefined, places = 2): string =>
  typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(places)} τ` : "—";

export const fmtCompactTao = (value: number | null | undefined): string => {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M τ`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k τ`;
  return `${value.toFixed(2)} τ`;
};

/** A signed TAO figure, for a net-flow reading where the sign is the point. */
export const fmtSignedTao = (value: number | null | undefined): string =>
  typeof value === "number" && Number.isFinite(value)
    ? `${value >= 0 ? "+" : "−"}${fmtCompactTao(Math.abs(value))}`
    : "—";

export interface PositionRow {
  key: string;
  netuid: number;
  label: string;
  value: number;
  hotkeys: number;
  share: number;
}

/**
 * Live positions collapsed to one row per subnet.
 *
 * `/positions` is per (hotkey, netuid) and an account commonly holds the same
 * subnet through several hotkeys -- 61 positions across 5 subnets on the
 * account this page is measured against. Railing the raw rows would show the
 * same subnet five times and let the reader add it up.
 */
export function positionsBySubnet(
  positions: readonly AccountPosition[],
  nameOf: (netuid: number) => string,
): PositionRow[] {
  const bySubnet = new Map<number, { value: number; hotkeys: Set<string> }>();
  for (const position of positions) {
    if (typeof position.netuid !== "number") continue;
    const stake = typeof position.stake_tao === "number" ? position.stake_tao : 0;
    const entry = bySubnet.get(position.netuid) ?? { value: 0, hotkeys: new Set<string>() };
    entry.value += stake;
    if (position.hotkey) entry.hotkeys.add(position.hotkey);
    bySubnet.set(position.netuid, entry);
  }
  const total = [...bySubnet.values()].reduce((acc, entry) => acc + entry.value, 0);
  return [...bySubnet.entries()]
    .map(([netuid, entry]) => ({
      key: `sn-${netuid}`,
      netuid,
      label: nameOf(netuid),
      value: entry.value,
      hotkeys: entry.hotkeys.size,
      share: total > 0 ? entry.value / total : 0,
    }))
    .sort((a, b) => b.value - a.value);
}

export interface FlowColumn {
  key: string;
  label: string;
  axisLabel: string;
  total: number;
  segments: { key: string; label: string; value: number }[];
}

/**
 * Stake movement per subnet, as one column each.
 *
 * Columns are subnets rather than weeks because `/stake-flow` publishes a
 * per-subnet total for the window and no time series -- drawing weeks would
 * mean inventing them. Both directions are always present so a subnet the
 * account only exited still shows the bar that says so.
 */
export function flowColumns(
  subnets: readonly AccountStakeFlowSubnet[],
  nameOf: (netuid: number) => string,
): FlowColumn[] {
  return subnets
    .map((subnet) => {
      const staked = typeof subnet.staked_tao === "number" ? subnet.staked_tao : 0;
      const unstaked = typeof subnet.unstaked_tao === "number" ? subnet.unstaked_tao : 0;
      return {
        key: `sn-${subnet.netuid}`,
        label: nameOf(subnet.netuid),
        axisLabel: `SN${subnet.netuid}`,
        total: staked + unstaked,
        segments: [
          { key: "staked", label: "Staked in", value: staked },
          { key: "unstaked", label: "Unstaked out", value: unstaked },
        ],
      };
    })
    .filter((column) => column.total > 0)
    .sort((a, b) => b.total - a.total);
}

export interface CounterpartyRow {
  key: string;
  label: string;
  value: number;
  href: string;
  detail: { key: string; label: string; value: string }[];
}

/**
 * Transfer partners ranked by how much moved, in either direction.
 *
 * By GROSS, not net: an address that sent 1,000 τ and received 1,000 τ back
 * has a net of zero and is the account's most significant counterparty, and
 * ranking by net would put it last.
 */
export function counterpartyRail(
  counterparties: readonly AccountCounterparty[],
  limit = 10,
): CounterpartyRow[] {
  return counterparties
    .map((row) => {
      const sent = typeof row.sent_tao === "number" ? row.sent_tao : 0;
      const received = typeof row.received_tao === "number" ? row.received_tao : 0;
      return {
        key: row.address,
        label: `${row.address.slice(0, 6)}…${row.address.slice(-4)}`,
        value: sent + received,
        href: `/accounts/${row.address}`,
        detail: [
          { key: "sent", label: "Sent", value: fmtCompactTao(sent) },
          { key: "received", label: "Received", value: fmtCompactTao(received) },
          { key: "net", label: "Net", value: fmtSignedTao(received - sent) },
          { key: "transfers", label: "Transfers", value: String(row.transfer_count ?? 0) },
        ],
      };
    })
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

/** The distinct event kinds present, busiest first, for the activity filter. */
export function eventKindOptions(
  kinds: readonly { kind: string; count: number }[],
): { value: string; label: string }[] {
  return [...kinds]
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count)
    .map((entry) => ({ value: entry.kind, label: `${entry.kind} (${entry.count})` }));
}

/** The subnets an event stream touches, for the activity filter. */
export function eventSubnetOptions(
  events: readonly AccountEvent[],
  nameOf: (netuid: number) => string,
): { value: string; label: string }[] {
  const seen = new Set<number>();
  for (const event of events) {
    if (typeof event.netuid === "number") seen.add(event.netuid);
  }
  return [...seen]
    .sort((a, b) => a - b)
    .map((netuid) => ({ value: String(netuid), label: nameOf(netuid) }));
}

export interface KeyRow {
  key: string;
  label: string;
  role: string;
  href: string;
  value?: string;
}

/**
 * Every key the chain ties to this account, with the tie named.
 *
 * The role is the whole point: a hotkey this coldkey stakes through, a child
 * it delegates to and a parent that delegates to it are three different
 * relationships, and a bare list of addresses says none of them.
 */
export function relatedKeys(
  positions: readonly AccountPosition[],
  children: readonly AccountDelegationEdge[],
  parents: readonly AccountDelegationEdge[],
): KeyRow[] {
  const rows: KeyRow[] = [];
  const hotkeys = new Map<string, number>();
  for (const position of positions) {
    if (!position.hotkey) continue;
    const stake = typeof position.stake_tao === "number" ? position.stake_tao : 0;
    hotkeys.set(position.hotkey, (hotkeys.get(position.hotkey) ?? 0) + stake);
  }
  for (const [hotkey, stake] of [...hotkeys.entries()].sort((a, b) => b[1] - a[1])) {
    rows.push({
      key: hotkey,
      label: `${hotkey.slice(0, 6)}…${hotkey.slice(-4)}`,
      role: "stakes through",
      href: `/validators/${hotkey}`,
      value: fmtCompactTao(stake),
    });
  }
  for (const [list, role] of [
    [children, "delegates to"],
    [parents, "delegated by"],
  ] as const) {
    for (const entry of list) {
      const hotkey = entry.counterpart;
      if (!hotkey || rows.some((row) => row.key === hotkey)) continue;
      rows.push({
        key: hotkey,
        label: `${hotkey.slice(0, 6)}…${hotkey.slice(-4)}`,
        role,
        href: `/validators/${hotkey}`,
        value:
          typeof entry.proportion_fraction === "number"
            ? `${(entry.proportion_fraction * 100).toFixed(1)}%`
            : undefined,
      });
    }
  }
  return rows;
}
