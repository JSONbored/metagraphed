import { round9 } from "./lib/rao.ts";
// #10486: what moves through a DECLARED wallet, per window.
//
// Aggregation only. Attribution comes from registry/entities/ (#10483) and is
// never inferred here -- this module is handed a set of addresses somebody
// already proved belong to somebody, and it reports what moved through them.
// That separation is the point: a high-volume address receiving from many
// parties looks exactly like a treasury, and #10448 nearly recorded SN64's own
// protocol TAO reserve as a Chutes collector on precisely that reasoning. An
// aggregator that could also decide ownership would make that mistake cheap.
//
// TAO AND ALPHA ARE NEVER SUMMED. They are different tokens -- and alpha is a
// different token PER SUBNET, so even two alpha figures are only comparable
// when they share a netuid. A single "value moved" field would be the unit trap
// this epic already catalogues (a path named /tao returning USD), except
// self-inflicted. Each denomination is reported on its own leg, and a caller
// that wants one number has to say which rate it used.
//
// No new capture: the inputs are the same rows that already power
// /accounts/{ss58}/transfers (native TAO) and the stake streams (alpha).

/** What kind of movement a row represents. */
export type WalletFlowDenomination = "tao" | "alpha";

export interface WalletFlowRow {
  /** The declared address this row belongs to. */
  address: string;
  denomination: WalletFlowDenomination;
  /** Required for alpha: 1 alpha on two subnets is two different values. */
  netuid?: number | null;
  direction: "in" | "out";
  amount: number | null;
  observed_at?: string | null;
}

export interface WalletLeg {
  denomination: WalletFlowDenomination;
  /** Null for TAO; the subnet whose alpha this is, otherwise. */
  netuid: number | null;
  in: number;
  out: number;
  /** in - out. Negative is a real answer: more left than arrived. */
  net: number;
  events: number;
}

export interface WalletActivity {
  address: string;
  window_days: number;
  /** One leg per (denomination, netuid). Never collapsed into a total. */
  legs: WalletLeg[];
  event_count: number;
  first_observed_at: string | null;
  last_observed_at: string | null;
  /** Rows that could not be attributed to a leg, and why. */
  skipped: Array<{ reason: string; count: number }>;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function legKey(denomination: string, netuid: number | null): string {
  return `${denomination}:${netuid ?? "-"}`;
}

/** TAO sorts before every alpha leg; alpha legs sort by netuid. */
function legOrder(leg: WalletLeg): number {
  return leg.denomination === "tao" ? -1 : (leg.netuid as number);
}

/**
 * Aggregate one declared wallet's flows.
 *
 * Never throws and never drops a row silently: a row it cannot place is counted
 * in `skipped` with a reason, because a quietly-discarded movement is exactly
 * the kind of gap that makes a net figure look complete when it is not.
 */
export function aggregateWalletActivity(
  address: string,
  rows: WalletFlowRow[] | null | undefined,
  { window_days = 30 }: { window_days?: number } = {},
): WalletActivity {
  const legs = new Map<string, WalletLeg>();
  const skipped = new Map<string, number>();
  let events = 0;
  let first: string | null = null;
  let last: string | null = null;

  const skip = (reason: string) =>
    skipped.set(reason, (skipped.get(reason) ?? 0) + 1);

  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.address !== address) {
      skip("row belongs to a different address");
      continue;
    }
    const amount = finite(row?.amount);
    if (amount === null || amount < 0) {
      skip("amount not readable");
      continue;
    }
    if (row.denomination !== "tao" && row.denomination !== "alpha") {
      skip("unknown denomination");
      continue;
    }
    // Alpha WITHOUT a netuid cannot be placed on a leg, because there is no
    // single "alpha" to add it to. Dropping it into a shared bucket is the
    // exact conflation this module refuses to make.
    const netuid =
      row.denomination === "alpha" ? (finite(row.netuid) ?? null) : null;
    if (row.denomination === "alpha" && netuid === null) {
      skip("alpha row carries no netuid, so it belongs to no leg");
      continue;
    }
    if (row.direction !== "in" && row.direction !== "out") {
      skip("direction not readable");
      continue;
    }

    const key = legKey(row.denomination, netuid);
    const leg = legs.get(key) ?? {
      denomination: row.denomination,
      netuid,
      in: 0,
      out: 0,
      net: 0,
      events: 0,
    };
    if (row.direction === "in") leg.in = round9(leg.in + amount);
    else leg.out = round9(leg.out + amount);
    leg.net = round9(leg.in - leg.out);
    leg.events += 1;
    legs.set(key, leg);

    events += 1;
    const at = typeof row.observed_at === "string" ? row.observed_at : null;
    if (at) {
      if (first === null || at < first) first = at;
      if (last === null || at > last) last = at;
    }
  }

  return {
    address,
    window_days,
    // Deterministic order so two callers comparing the same wallet see the
    // same shape: TAO first, then alpha by netuid. No nullish fallback in the
    // comparator -- an alpha leg always carries a netuid (enforced above) and
    // there is at most one TAO leg, so a `?? -1` would be a branch nothing can
    // reach.
    legs: [...legs.values()].sort((a, b) => legOrder(a) - legOrder(b)),
    event_count: events,
    first_observed_at: first,
    last_observed_at: last,
    skipped: [...skipped.entries()].map(([reason, count]) => ({
      reason,
      count,
    })),
  };
}

export interface DeclaredWallet {
  ss58: string;
  /** The declared role, from registry/entities/. Never derived here. */
  category: string;
  netuid?: number | null;
  /** The evidence, carried through so a consumer never has to re-look it up. */
  source_urls?: string[];
}

/**
 * Every declared wallet's activity for one subnet.
 *
 * A declared wallet with NO rows is included with empty legs rather than
 * dropped -- "we watched this address and nothing moved" is a finding, and
 * omitting it would make the set of active wallets look like the set of
 * declared ones.
 */
export function aggregateDeclaredWallets(
  wallets: DeclaredWallet[] | null | undefined,
  rowsByAddress: Map<string, WalletFlowRow[]> | null | undefined,
  options: { window_days?: number } = {},
): Array<DeclaredWallet & { activity: WalletActivity }> {
  const out: Array<DeclaredWallet & { activity: WalletActivity }> = [];
  for (const wallet of Array.isArray(wallets) ? wallets : []) {
    const ss58 = typeof wallet?.ss58 === "string" ? wallet.ss58 : "";
    if (!ss58) continue;
    out.push({
      ...wallet,
      activity: aggregateWalletActivity(
        ss58,
        rowsByAddress?.get(ss58) ?? [],
        options,
      ),
    });
  }
  return out;
}
