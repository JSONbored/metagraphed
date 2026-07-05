import { formatNumber } from "@/lib/metagraphed/format";
import type { SubnetStakeTransfers } from "@/lib/metagraphed/types";

// #3484: view-model for the economics-panel stake-transfers StatTile. Consumes the
// already-shipped subnetStakeTransfersQuery card (transfer_stake activity over the
// window) and folds it into display strings. Kept pure + framework-free so the
// count/sender/average formatting and the idle vs. active states are unit-tested
// without rendering; the component just spreads the result onto <StatTile />.

export interface StakeTransfersTileModel {
  eyebrow: string;
  value: string;
  hint: string;
  tone: "default" | "accent";
  hasActivity: boolean;
}

/**
 * Fold a normalized SubnetStakeTransfers card into a StatTile view-model.
 * Missing / cold / junk cards degrade to a stable zeroed "no transfers" tile
 * (never NaN, never a thrown), so the tile renders regardless of store state.
 */
export function stakeTransfersTileModel(
  card?: SubnetStakeTransfers | null,
): StakeTransfersTileModel {
  const transfers = card && Number.isFinite(card.transfers) ? card.transfers : 0;
  const senders = card && Number.isFinite(card.distinct_senders) ? card.distinct_senders : 0;
  const perSender = card?.transfers_per_sender;
  const hasActivity = transfers > 0;

  const senderLabel = `${formatNumber(senders)} ${senders === 1 ? "sender" : "senders"}`;
  const avgLabel =
    perSender != null && Number.isFinite(perSender) ? ` · ${perSender.toFixed(1)}/sender` : "";

  return {
    eyebrow: "Stake transfers",
    value: formatNumber(transfers),
    hint: hasActivity ? `${senderLabel}${avgLabel}` : "no transfers",
    tone: hasActivity ? "accent" : "default",
    hasActivity,
  };
}
