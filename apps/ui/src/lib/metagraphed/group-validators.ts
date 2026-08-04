import type { GlobalValidator } from "./types";

export interface OperatorGroupInfo {
  /** Total keys this operator runs in the current (filtered) view. */
  size: number;
  /** This row's position within its operator group — 0 is the anchor row. */
  index: number;
}

/**
 * Cluster an operator's validator keys adjacent under its best-ranked row.
 *
 * Teams run several validator keys (Ventura Labs, Yuma, …), and a flat ranked
 * list repeats the same operator name at every rank its keys land on. This
 * regroups the CURRENT sort order without inventing aggregate rows: the first
 * row an operator occurs at (its best rank under the active sort) becomes the
 * group anchor, its remaining keys are pulled up adjacent to it in their own
 * relative order, and everything else keeps its position. Every row is still a
 * real per-key row — nothing is summed or blended across keys, so per-key
 * take/APY/stake stay honest and every row still links to its own detail page.
 *
 * Grouping is by the coldkey identity's declared name (trimmed): the same
 * self-declared brand across keys IS the duplication being collapsed. Rows
 * without a declared identity are their own group of one.
 */
export function groupByOperator(rows: GlobalValidator[]): {
  list: GlobalValidator[];
  info: Map<string, OperatorGroupInfo>;
} {
  const nameOf = (v: GlobalValidator): string | null => {
    const name = v.coldkey_identity?.has_identity ? v.coldkey_identity.name : null;
    const trimmed = typeof name === "string" ? name.trim() : "";
    return trimmed.length > 0 ? trimmed : null;
  };
  const members = new Map<string, GlobalValidator[]>();
  const anchors: GlobalValidator[] = [];
  for (const v of rows) {
    const name = nameOf(v);
    if (!name) {
      anchors.push(v);
      continue;
    }
    const group = members.get(name);
    if (group) group.push(v);
    else {
      members.set(name, [v]);
      anchors.push(v);
    }
  }
  const list: GlobalValidator[] = [];
  const info = new Map<string, OperatorGroupInfo>();
  for (const anchor of anchors) {
    const name = nameOf(anchor);
    const group = name ? (members.get(name) ?? [anchor]) : [anchor];
    group.forEach((v, index) => {
      list.push(v);
      info.set(v.hotkey, { size: group.length, index });
    });
  }
  return { list, info };
}
