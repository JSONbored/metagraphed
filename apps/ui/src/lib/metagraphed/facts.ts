import type { ReactNode } from "react";
import type { FactCells } from "@jsonbored/ui-kit";

/** One headline number, as the pages that derive them already shape it. */
export interface HeadlineFact {
  key: string;
  label: string;
  value: ReactNode;
  /** A signed change shown right of the value; `tone` colours it. */
  delta?: { text: string; tone: "good" | "bad" | "neutral" };
}

/**
 * A page's headline numbers as a `FactStrip`, or `null` when there are too few
 * to make a strip.
 *
 * ELEVEN routes stated their headline numbers as 11px `Fact` chips inside the
 * hero sentence and never rendered a strip at all (#11696) -- every one of them
 * a page whose subject is a table, so the numbers that frame the table were set
 * smaller than the table's own row text. The chips are right for an entity's
 * IDENTITY ("hotkey 5E2LP6…eZ5u", "authority official"); they are wrong for the
 * five counts a reader came to the page for.
 *
 * Written as a switch rather than a cast. `FactCells` is a 2-to-6 TUPLE, and
 * `as unknown as FactCells` over an array would compile while telling the
 * compiler something it has not checked -- the pattern the boundary-cast gate
 * exists to keep out of this repo, whether or not it scans this workspace.
 */
export function factCells(facts: readonly HeadlineFact[]): FactCells | null {
  const cells = facts
    .slice(0, 6)
    .map(({ label, value, delta }) => (delta ? { label, value, delta } : { label, value }));
  switch (cells.length) {
    case 2:
      return [cells[0]!, cells[1]!];
    case 3:
      return [cells[0]!, cells[1]!, cells[2]!];
    case 4:
      return [cells[0]!, cells[1]!, cells[2]!, cells[3]!];
    case 5:
      return [cells[0]!, cells[1]!, cells[2]!, cells[3]!, cells[4]!];
    case 6:
      return [cells[0]!, cells[1]!, cells[2]!, cells[3]!, cells[4]!, cells[5]!];
    default:
      return null;
  }
}
