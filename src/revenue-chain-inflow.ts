// #10445: revenue measured from our own transfer index, with no trust in the
// operator's API.
//
// The Tier-A path. #10448 established it is real -- 32/32 Chutes payments for
// 2026-08-08 matched on-chain Balances.Transfer events with a delta of
// 0.000000000 TAO -- and also established its limit: the TAO channel was
// $1,036.50 against $9,776.06 total revenue that day, so this corroborates the
// operator on ~10% of the figure rather than replacing the feed.
//
// Four rules, each of which was a wrong answer before it was a rule:
//
//   1. INBOUND ONLY. A sweep OUT of a collector is treasury movement, not
//      negative revenue. Netting the two would let a subnet reduce its own
//      reported revenue by moving its money.
//   2. PROTOCOL ACCOUNTS ARE REFUSED. A subnet's own TAO reserve receives large,
//      continuous, many-party inbound -- because that is what buying alpha looks
//      like -- and presents exactly like a payment collector. #10448 nearly
//      recorded SN64's as one.
//   3. EACH INFLOW IS PRICED AT ITS OWN INSTANT, not at a window-average rate.
//      A window average silently backdates today's TAO price onto a payment
//      made when it was worth something else.
//   4. ALPHA IS CLASSIFIED, NOT SUMMED. An inflow denominated in the subnet's
//      own alpha is circular, not external, and adding it to a USD total would
//      quietly count a subnet paying itself.
import { protocolSubnetNetuid } from "./subnet-accounts.ts";

export interface ChainTransfer {
  to: string;
  from: string;
  /** TAO, already scaled from rao. */
  amount_tao: number;
  block_number: number;
  observed_at: number;
  /** Present when the transfer moved a subnet's alpha rather than TAO. */
  alpha_netuid?: number | null;
}

export interface InflowInput {
  /** Addresses declared `payment-collector` for this subnet, from the entity
   * registry. */
  collectors: string[];
  netuid: number;
  transfers: ChainTransfer[];
  /** TAO/USD at a given instant. Returning null means the price is unknown for
   * that moment, which is not the same as zero. */
  usdAtInstant: (observedAt: number) => number | null;
}

export interface InflowResult {
  netuid: number;
  /** Summed external TAO inflow to the declared collectors. */
  tao: number;
  /** Priced at each transfer's own instant. Null when NO transfer could be
   * priced -- an unpriced total is not a zero total. */
  usd: number | null;
  transfer_count: number;
  /** Inflows deliberately not counted, with the reason. Reported rather than
   * dropped: a silently-filtered inflow is indistinguishable from one that
   * never happened. */
  excluded: Array<{ reason: string; count: number; tao: number }>;
  /** Collectors refused before any transfer was read. */
  rejected_collectors: Array<{ ss58: string; reason: string }>;
}

function bump(
  map: Map<string, { count: number; tao: number }>,
  reason: string,
  tao: number,
): void {
  const entry = map.get(reason) ?? { count: 0, tao: 0 };
  entry.count += 1;
  entry.tao += tao;
  map.set(reason, entry);
}

/**
 * Aggregate inbound TAO to a subnet's declared payment collectors.
 *
 * `transfers` is whatever the caller pulled for the window; filtering to the
 * collectors happens here so the rules live in one place rather than in each
 * caller's query.
 */
export function aggregateChainInflow(input: InflowInput): InflowResult {
  const { collectors, netuid, transfers, usdAtInstant } = input;

  const accepted = new Set<string>();
  const rejected: InflowResult["rejected_collectors"] = [];
  for (const ss58 of collectors) {
    const protocolNetuid = protocolSubnetNetuid(ss58);
    if (protocolNetuid !== null) {
      rejected.push({
        ss58,
        reason:
          `protocol-derived TAO account for netuid ${protocolNetuid} — its inbound is ` +
          "users staking to buy alpha, a capital flow, not revenue (#10448)",
      });
      continue;
    }
    accepted.add(ss58);
  }

  const excluded = new Map<string, { count: number; tao: number }>();
  let tao = 0;
  let usd = 0;
  let priced = 0;
  let counted = 0;

  for (const transfer of transfers) {
    if (!accepted.has(transfer.to)) {
      // Outbound from a collector is the case worth naming: it is treasury
      // movement, and netting it would let a subnet reduce its reported
      // revenue by moving its own money.
      if (accepted.has(transfer.from)) {
        bump(excluded, "outbound from a collector", transfer.amount_tao);
      }
      continue;
    }
    if (
      typeof transfer.alpha_netuid === "number" &&
      Number.isFinite(transfer.alpha_netuid)
    ) {
      bump(
        excluded,
        "alpha-denominated, so circular not external",
        transfer.amount_tao,
      );
      continue;
    }
    if (!Number.isFinite(transfer.amount_tao) || transfer.amount_tao <= 0) {
      bump(excluded, "non-positive or non-finite amount", 0);
      continue;
    }
    counted += 1;
    tao += transfer.amount_tao;
    const rate = usdAtInstant(transfer.observed_at);
    if (rate !== null && Number.isFinite(rate)) {
      priced += 1;
      usd += transfer.amount_tao * rate;
    }
  }

  return {
    netuid,
    tao: Math.round(tao * 1e9) / 1e9,
    // A total nobody could price is null, not zero. Partial pricing still
    // reports what it could price, and the caller can see the gap from
    // transfer_count.
    usd: priced > 0 ? Math.round(usd * 1e6) / 1e6 : null,
    transfer_count: counted,
    excluded: [...excluded.entries()].map(([reason, v]) => ({
      reason,
      count: v.count,
      tao: Math.round(v.tao * 1e9) / 1e9,
    })),
    rejected_collectors: rejected,
  };
}
