import type { SubnetStakeMoves } from "./types";

export interface StakeMovesTileModel {
  /** Total StakeMoved (re-delegation) events in the window. */
  movements: number;
  /** Distinct movers (unique re-delegating hotkeys). */
  movers: number;
  /** Repeat moves beyond the first per mover (movements - movers, floored at 0). */
  repeats: number;
  /** Average moves per mover, or null on a cold / junk store. */
  perMover: number | null;
  /** MiniStack composition: unique movers vs repeat moves. */
  segments: Array<{ label: string; value: number; color: string }>;
  /** Short human summary for the SparkLegend tooltip. */
  summary: string;
}

/**
 * #3485: derive the economics-panel stake-moves tile model from the flat
 * StakeMoved window summary. `movements` is the headline count; the MiniStack
 * splits it into unique re-delegators (`distinct_movers`) vs repeat moves so a
 * single-snapshot aggregate still reads as a composition rather than a lone
 * number. Everything coerces defensively — a cold / undefined card degrades to a
 * zeroed, empty-bar model, and a junk store where movers exceeds movements can
 * never produce a negative repeat count.
 */
export function stakeMovesTileModel(card: SubnetStakeMoves | undefined): StakeMovesTileModel {
  const movements = Math.max(0, card?.movements ?? 0);
  const movers = Math.max(0, card?.distinct_movers ?? 0);
  const repeats = Math.max(0, movements - movers);
  const perMover =
    card?.movements_per_mover != null && Number.isFinite(card.movements_per_mover)
      ? card.movements_per_mover
      : null;
  const segments = [
    { label: "movers", value: movers, color: "var(--accent)" },
    { label: "repeat moves", value: repeats, color: "var(--border)" },
  ];
  const summary =
    movements > 0
      ? `${movers} mover${movers === 1 ? "" : "s"}${
          repeats > 0 ? `, ${repeats} repeat move${repeats === 1 ? "" : "s"}` : ""
        }`
      : "no re-delegations in this window";
  return { movements, movers, repeats, perMover, segments, summary };
}
