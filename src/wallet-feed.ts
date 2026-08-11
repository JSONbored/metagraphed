// #10512: surface wallet movement, including the movement that is not supposed
// to happen.
//
// THE BURN-CLAIM ITEM IS THE HIGHEST-BLAST-RADIUS THING EITHER EPIC EMITS.
// It says a team's published claim and the chain disagree, about an address a
// reader can look up, and it will be quoted without its caveats. So the wording
// is settled ONCE -- in src/burn-outflow-watchdog.ts's READING, reused verbatim
// here rather than restated -- and it names our own misattribution as a live
// explanation before it names anything else. It states the claim, states the
// observation, states the delta, and stops. It never asserts intent, and the
// tests assert the absence of intent-words as hard as they assert the presence
// of the evidence.
//
// THE OTHER THREE KINDS EXIST SO THE BURN ITEM IS NOT THE ONLY ONE. A feed that
// only ever fires on the worst finding trains its readers to treat any item as
// an accusation. Attributions arriving, attributions being reviewed, and
// treasuries moving money are ordinary events, and publishing them is what
// makes the fourth kind legible as the exception it is.
//
// NOTHING IS EMITTED FROM AN ABSENCE. A flow item needs a price for its leg;
// alpha is a different token per subnet, so an unpriced leg produces no item
// rather than an item comparing two tokens.
import { subnetPageUrl } from "./contracts.ts";
import {
  BURN_OUTFLOW_DUST_FLOOR,
  detectBurnOutflow,
  type BurnDiscrepancy,
} from "./burn-outflow-watchdog.ts";
import type { FeedItem } from "./feeds.ts";
import type { DeclaredWallet, WalletFlowRow } from "./wallet-activity.ts";

/** A treasury movement below this many US dollars is housekeeping. Set high
 * enough that a gas top-up or a test transfer is not an event, and low enough
 * that a real disbursement is. */
export const WALLET_FLOW_MATERIAL_USD = 10_000;

const DAY_MS = 86_400_000;

/** The registry record as the feed reads it: the declared wallet plus the
 * governance block that dates it. */
export interface WalletAttributionRecord extends DeclaredWallet {
  name?: string | null;
  review?: {
    state?: string | null;
    submitted_at?: string | null;
    reviewed_at?: string | null;
  } | null;
}

/** What a leg has to be priced through to become a dollar figure. Alpha is
 * priced through ITS OWN subnet's pool, never another's. */
export interface WalletFeedPrices {
  usd_per_tao: number | null;
  /** netuid -> alpha price in TAO. A netuid absent here is UNPRICED, which
   * suppresses its item rather than defaulting it. */
  alpha_price_tao?: Map<number, number> | null;
}

export interface WalletFeedInput {
  wallets: WalletAttributionRecord[] | null | undefined;
  rowsByAddress?: Map<string, WalletFlowRow[]> | null;
  prices?: WalletFeedPrices | null;
  windowDays?: number;
  now?: number;
  /** Overrides the dust floor the burn detector applies. Exposed only so the
   * watchdog and the feed cannot drift apart in a test. */
  minBurnAmount?: number;
}

function msOrNull(value: unknown): number | null {
  if (value == null) return null;
  const raw = String(value);
  if (/^-?\d{10,}$/.test(raw)) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function usd(amount: number): string {
  return `$${Math.round(amount).toLocaleString("en-US")}`;
}

function subnetLabel(netuid: number | null | undefined): string {
  return netuid == null ? "An unattributed address" : `Subnet ${netuid}`;
}

function evidenceClause(sourceUrls: string[] | undefined): string {
  return sourceUrls?.length
    ? ` The attribution rests on: ${sourceUrls.join(", ")}.`
    : " No evidence URLs are recorded for this attribution, which is itself" +
        " worth checking before repeating it.";
}

/** One burn-claim discrepancy, as a feed item.
 *
 * The reading is the watchdog's, verbatim. Restating it here in feed-shaped
 * prose is exactly how a caveat gets softened one word at a time. */
function burnItem(finding: BurnDiscrepancy): FeedItem {
  const when = finding.observed_at ?? new Date(0).toISOString();
  const unit =
    finding.denomination === "alpha"
      ? `alpha${finding.netuid == null ? "" : ` (subnet ${finding.netuid})`}`
      : "TAO";
  return {
    id: `wallet-burn-claim:${finding.address}:${when}:${finding.amount}`,
    url: subnetPageUrl(finding.netuid ?? null),
    title: `${subnetLabel(finding.netuid)} — outbound movement from an address declared unspendable`,
    summary:
      `THE CLAIM: \`${finding.address}\` is declared \`category: burn\`, meaning what it receives cannot be spent. ` +
      `THE OBSERVATION: ${finding.amount} ${unit} moved OUT of it on ${when}. ` +
      `THE DELTA: an address that cannot spend moved ${finding.amount} ${unit}. ` +
      `${finding.reading}` +
      evidenceClause(finding.source_urls),
    timestamp: when,
    tags: ["wallets", "burn-claim"],
  };
}

/**
 * The wallet feed's items.
 *
 * Pure over records already read, so the wording -- the part that gets quoted
 * -- is testable without a store.
 */
export function walletFeedItems(input: WalletFeedInput): FeedItem[] {
  const now = input.now ?? Date.now();
  const cutoff = now - (input.windowDays ?? 30) * DAY_MS;
  const wallets = Array.isArray(input.wallets) ? input.wallets : [];
  const items: FeedItem[] = [];

  // ── the discrepancy ───────────────────────────────────────────────────────
  for (const finding of detectBurnOutflow(wallets, input.rowsByAddress, {
    minAmount: input.minBurnAmount ?? BURN_OUTFLOW_DUST_FLOOR,
  })) {
    const at = msOrNull(finding.observed_at);
    // An undated discrepancy is still reported: the movement happened, and
    // dropping it because the index lost a timestamp would silence the one
    // finding this lane exists for.
    if (at != null && at < cutoff) continue;
    items.push(burnItem(finding));
  }

  for (const wallet of wallets) {
    const ss58 = typeof wallet?.ss58 === "string" ? wallet.ss58 : "";
    if (!ss58 || !wallet.category) continue;
    const netuid = wallet.netuid ?? null;

    // ── a new attribution ───────────────────────────────────────────────────
    //
    // Dated by the submission, and carrying the governance state, because
    // "somebody submitted this" and "a maintainer checked it" are different
    // claims and only one of them is a review.
    const submittedAt = msOrNull(wallet.review?.submitted_at);
    if (submittedAt != null && submittedAt >= cutoff) {
      const when = new Date(submittedAt).toISOString();
      const state = wallet.review?.state ?? "unrecorded";
      items.push({
        id: `wallet-attributed:${ss58}:${when}`,
        url: subnetPageUrl(netuid),
        title: `${subnetLabel(netuid)} — ${wallet.category} address attributed${wallet.name ? ` to ${wallet.name}` : ""}`,
        summary:
          `\`${ss58}\` is now attributed as \`${wallet.category}\`${wallet.name ? ` for ${wallet.name}` : ""}, submitted ${when}. ` +
          `Governance state is \`${state}\`${state === "community-submitted" ? ", meaning it has been submitted and not yet checked by a maintainer" : ""}. ` +
          `An attribution is a human claim about who controls an address and may be wrong.` +
          evidenceClause(wallet.source_urls),
        timestamp: when,
        tags: ["wallets", "attribution"],
      });
    }

    // ── a review outcome ────────────────────────────────────────────────────
    //
    // Separate from the submission, because a promotion is the event a reader
    // wanting to know how much to trust an attribution is actually waiting for.
    const reviewedAt = msOrNull(wallet.review?.reviewed_at);
    if (reviewedAt != null && reviewedAt >= cutoff) {
      const when = new Date(reviewedAt).toISOString();
      const state = wallet.review?.state ?? "unrecorded";
      items.push({
        id: `wallet-reviewed:${ss58}:${when}`,
        url: subnetPageUrl(netuid),
        title: `${subnetLabel(netuid)} — ${wallet.category} attribution reviewed: ${state}`,
        summary:
          `The \`${wallet.category}\` attribution for \`${ss58}\` was reviewed on ${when} and is now \`${state}\`. ` +
          `A maintainer review checks that the published evidence supports the attribution. It does not verify what the address is used for.` +
          evidenceClause(wallet.source_urls),
        timestamp: when,
        tags: ["wallets", "review"],
      });
    }
  }

  items.push(...flowItems(wallets, input, cutoff));
  return items;
}

/**
 * Material treasury movement.
 *
 * PRICED OR ABSENT. TAO and alpha are different tokens and two subnets' alpha
 * are different tokens from each other, so materiality is only expressible once
 * both are in the same unit. A leg whose price is missing produces NO item --
 * publishing it against an unpriced amount would either compare two tokens or
 * invite the reader to.
 */
function flowItems(
  wallets: WalletAttributionRecord[],
  input: WalletFeedInput,
  cutoff: number,
): FeedItem[] {
  const out: FeedItem[] = [];
  const usdPerTao = input.prices?.usd_per_tao ?? null;
  if (usdPerTao == null || !(usdPerTao > 0)) return out;

  for (const wallet of wallets) {
    const ss58 = typeof wallet?.ss58 === "string" ? wallet.ss58 : "";
    // Burn addresses are covered by the discrepancy item above, at a floor of
    // dust rather than of materiality. Reporting them here too would put the
    // same movement in the feed twice with two different framings.
    if (!ss58 || wallet.category === "burn") continue;

    for (const row of input.rowsByAddress?.get(ss58) ?? []) {
      if (row?.address !== ss58) continue;
      const amount =
        typeof row.amount === "number" && Number.isFinite(row.amount)
          ? row.amount
          : null;
      if (amount == null || amount <= 0) continue;
      const at = msOrNull(row.observed_at);
      if (at == null || at < cutoff) continue;

      let taoValue: number | null = null;
      if (row.denomination === "tao") {
        taoValue = amount;
      } else if (row.denomination === "alpha") {
        const netuid = typeof row.netuid === "number" ? row.netuid : null;
        const alphaPrice =
          netuid == null
            ? null
            : (input.prices?.alpha_price_tao?.get(netuid) ?? null);
        // Priced through THIS subnet's pool or not at all. Falling back to
        // another subnet's price would produce a dollar figure that is wrong by
        // whatever the two pools differ by, and look exactly as authoritative.
        if (alphaPrice != null && alphaPrice > 0)
          taoValue = amount * alphaPrice;
      }
      if (taoValue == null) continue;

      const usdValue = taoValue * usdPerTao;
      if (usdValue < WALLET_FLOW_MATERIAL_USD) continue;

      const when = new Date(at).toISOString();
      const direction = row.direction === "out" ? "out of" : "into";
      // An alpha leg only reaches here if it was PRICED, which required a
      // netuid -- so the subnet is always nameable and the branch that omits
      // it would be unreachable.
      const unit =
        row.denomination === "alpha" ? `alpha (subnet ${row.netuid})` : "TAO";
      out.push({
        id: `wallet-flow:${ss58}:${when}:${row.direction}:${amount}`,
        url: subnetPageUrl(wallet.netuid ?? null),
        title: `${subnetLabel(wallet.netuid ?? null)} — ${amount} ${unit} moved ${direction} a declared ${wallet.category}`,
        summary:
          `${amount} ${unit} moved ${direction} \`${ss58}\`, a declared \`${wallet.category}\`, on ${when}. ` +
          `Worth about ${usd(usdValue)} at the time of reading; the dollar figure is a conversion for scale, not a valuation. ` +
          `A treasury moving money is ordinary activity and this item makes no claim about what it was for.` +
          evidenceClause(wallet.source_urls),
        timestamp: when,
        tags: ["wallets", "flow"],
      });
    }
  }
  return out;
}
