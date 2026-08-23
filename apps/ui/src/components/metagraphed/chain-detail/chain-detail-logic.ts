import type { Block, ChainEvent, Extrinsic } from "@/lib/metagraphed/types";
import { callLabel, eventLabel } from "@/components/metagraphed/chain-stream/chain-stream-logic";

/**
 * The derivations behind /blocks/$ref and /extrinsics/$hash (#11621). Pure,
 * so every rule below is testable without a browser and the two pages stay
 * thin enough to read in one sitting.
 */

/** How many blocks either side of the subject the cadence line covers. */
export const CADENCE_SPAN = 50;

/** The [start, end] block range a cadence line asks the feed for. */
export function cadenceRange(block: number, span = CADENCE_SPAN): [number, number] {
  // Clamped at the genesis end: a negative block_start is not a smaller
  // window, it is a request the API has no answer for.
  return [Math.max(0, block - span), block + span];
}

export interface CadencePoint {
  t: number;
  v: number;
  block: number;
}

/**
 * Block time against block number, for the window around one block.
 *
 * `t` is the BLOCK NUMBER, not a timestamp. The x axis of this chart is the
 * chain's own clock: plotting against wall time would space the points by the
 * very quantity the chart measures, so a slow block would be drawn wide as
 * well as tall and say the same thing twice.
 *
 * Ascending, because a chart read left-to-right is read oldest-first, while
 * the feed answers newest-first.
 */
export function cadencePoints(blocks: readonly Block[]): CadencePoint[] {
  const ordered = [...blocks].sort((a, b) => a.block_number - b.block_number);
  const points: CadencePoint[] = [];
  for (let i = 1; i < ordered.length; i += 1) {
    const now = ordered[i]!;
    const prev = ordered[i - 1]!;
    // Only consecutive blocks measure a block time. A gap in the feed would
    // otherwise be drawn as one very slow block, which is a claim about the
    // chain made from a fact about the indexer.
    if (now.block_number !== prev.block_number + 1) continue;
    const a = now.observed_at ? Date.parse(now.observed_at) : NaN;
    const b = prev.observed_at ? Date.parse(prev.observed_at) : NaN;
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const gap = a - b;
    if (gap <= 0) continue;
    points.push({ t: now.block_number, v: gap / 1000, block: now.block_number });
  }
  return points;
}

export interface Segment {
  key: string;
  label: string;
  value: number;
}

/**
 * A block's events grouped by pallet, largest first.
 *
 * By pallet rather than by `Pallet.Event`: a block emits a handful of pallets
 * and dozens of distinct events, and the question the composition answers is
 * "what kind of work was this block", which is the pallet's question.
 */
export function eventsByPallet(events: readonly ChainEvent[]): Segment[] {
  const counts = new Map<string, number>();
  for (const event of events) {
    const pallet = event.pallet?.trim();
    if (pallet) counts.set(pallet, (counts.get(pallet) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, value]) => ({ key, label: key, value }))
    .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
}

export interface ArgRow {
  key: string;
  name: string;
  type: string | null;
  value: string;
}

/**
 * An extrinsic's call arguments as name / type / decoded value rows.
 *
 * Values are stringified here rather than in the cell so the CSV, the sort
 * and the screen all say the same thing. An object or array argument is
 * rendered as compact JSON: it is one value, and splitting it into more rows
 * would invent structure the call does not have.
 */
export function argRows(args: Extrinsic["call_args"]): ArgRow[] {
  if (!Array.isArray(args)) return [];
  return args.map((arg, i) => {
    const record = (arg ?? {}) as Record<string, unknown>;
    const name = typeof record.name === "string" && record.name ? record.name : `arg ${i}`;
    return {
      key: `${i}-${name}`,
      name,
      type: typeof record.type === "string" && record.type ? record.type : null,
      value: stringifyArg(record.value),
    };
  });
}

function stringifyArg(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface Fact {
  key: string;
  label: string;
  value: string;
}

/**
 * The block hero's sentence facts.
 *
 * `spec` is included because it is the one field that tells a reader whether
 * this block ran the runtime they think it did, and it is free — the detail
 * response carries it. Size is NOT included: the endpoint publishes no byte
 * count for a block, and a stat strip with a permanent em-dash in it teaches
 * readers to stop reading stat strips.
 */
export function blockFacts(
  block: Block | null | undefined,
  fmt: { count: (n: number) => string },
): Fact[] {
  if (!block) return [];
  const facts: Fact[] = [];
  if (typeof block.extrinsic_count === "number") {
    facts.push({
      key: "extrinsics",
      label: "extrinsics",
      value: fmt.count(block.extrinsic_count),
    });
  }
  if (typeof block.event_count === "number") {
    facts.push({ key: "events", label: "events", value: fmt.count(block.event_count) });
  }
  const spec = block.spec_version;
  if (typeof spec === "number") facts.push({ key: "spec", label: "spec", value: fmt.count(spec) });
  return facts;
}

/** The extrinsic hero's sentence facts. */
export function extrinsicFacts(
  extrinsic: Extrinsic | null | undefined,
  fmt: { count: (n: number) => string; tao: (n: number) => string },
): Fact[] {
  if (!extrinsic) return [];
  const facts: Fact[] = [];
  if (typeof extrinsic.block_number === "number") {
    facts.push({
      key: "block",
      label: "in block",
      value: `#${fmt.count(extrinsic.block_number)}`,
    });
  }
  // Stated only when the tier HAS a reading: `success == null` means no
  // decode, which is not "failed" and must not be drawn as it.
  if (extrinsic.success != null) {
    facts.push({ key: "result", label: "result", value: extrinsic.success ? "ok" : "failed" });
  }
  if (typeof extrinsic.fee_tao === "number") {
    facts.push({ key: "fee", label: "fee", value: fmt.tao(extrinsic.fee_tao) });
  }
  if (typeof extrinsic.tip_tao === "number" && extrinsic.tip_tao > 0) {
    facts.push({ key: "tip", label: "tip", value: fmt.tao(extrinsic.tip_tao) });
  }
  return facts;
}

/** `module.function` for a title, or the hash's short form, or the ref. */
export function extrinsicTitle(extrinsic: Extrinsic | null | undefined, fallback: string): string {
  return callLabel(extrinsic?.call_module, extrinsic?.call_function) ?? fallback;
}

export { callLabel, eventLabel };

/**
 * The previous / next block a hero's two actions point at.
 *
 * Returned as hrefs rather than numbers so the caller cannot accidentally
 * build `/blocks/null`: an absent neighbour is an absent action, which is how
 * the head of the chain and genesis are meant to render.
 */
export function neighbourHrefs(
  prev: number | null | undefined,
  next: number | null | undefined,
): { prev: string | null; next: string | null } {
  return {
    prev: typeof prev === "number" ? `/blocks/${prev}` : null,
    next: typeof next === "number" ? `/blocks/${next}` : null,
  };
}
