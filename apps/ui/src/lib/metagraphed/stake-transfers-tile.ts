import type { SubnetStakeTransfers } from "./types";

export interface StakeTransfersTileModel {
  /** Total stake-transfer events in the window. */
  transfers: number;
  /** Distinct senders (unique transferring hotkeys). */
  senders: number;
  /** Repeat transfers beyond the first per sender (transfers - senders, floored at 0). */
  repeats: number;
  /** Average transfers per sender, or null on a cold / junk store. */
  perSender: number | null;
  /** MiniStack composition: unique senders vs repeat transfers. */
  segments: Array<{ label: string; value: number; color: string }>;
  /** Short human summary for the SparkLegend tooltip. */
  summary: string;
}

/**
 * #3484: derive the economics-panel stake-transfers tile model from the flat
 * stake-transfer window summary. `transfers` is the headline count; the MiniStack
 * splits it into unique senders (`distinct_senders`) vs repeat transfers so a
 * single-snapshot aggregate still reads as a composition rather than a lone
 * number. Everything coerces defensively — a cold / undefined card degrades to a
 * zeroed, empty-bar model, and a junk store where senders exceeds transfers can
 * never produce a negative repeat count.
 */
export function stakeTransfersTileModel(
  card: SubnetStakeTransfers | undefined,
): StakeTransfersTileModel {
  const transfers = Math.max(0, card?.transfers ?? 0);
  const senders = Math.max(0, card?.distinct_senders ?? 0);
  const repeats = Math.max(0, transfers - senders);
  const perSender =
    card?.transfers_per_sender != null && Number.isFinite(card.transfers_per_sender)
      ? card.transfers_per_sender
      : null;
  const segments = [
    { label: "senders", value: senders, color: "var(--accent)" },
    { label: "repeat transfers", value: repeats, color: "var(--border)" },
  ];
  const summary =
    transfers > 0
      ? `${senders} sender${senders === 1 ? "" : "s"}${
          repeats > 0 ? `, ${repeats} repeat transfer${repeats === 1 ? "" : "s"}` : ""
        }`
      : "no transfers in this window";
  return { transfers, senders, repeats, perSender, segments, summary };
}
