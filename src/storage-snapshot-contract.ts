// What a chain STORAGE snapshot is, and which items we snapshot (infra#452).
//
// ## Why storage is the only axis where waiting costs data
//
// Events and calls arrive INSIDE blocks, so decoding a block captures them by
// construction -- 211 of 289 event variants and 225 of 298 calls are already
// held, and the rest is a curation gap an indexer can close later. Storage is
// STATE and is never emitted. If a height is not snapshotted, that height's
// value survives only as long as an archive node serves it.
//
// Measured against `node-subtensor` spec 443: 371 declared storage items, 10
// held. `get_all_metagraphs` covers much of `SubtensorModule` indirectly, so
// that pallet overstates the gap -- but `Swap`, `Balances`, `Commitments` and
// `Crowdloan` are touched by nothing at all, and each is a place where we
// publish a DERIVED figure with no observed counterpart to check it against.
// `alpha_price_tao`, `tao_in_pool_tao` and `alpha_in_pool` are all derived from
// the AMM with nothing independent to reconcile them.
//
// ## Why the row carries the height, not just the value
//
// One row per `(pallet, item, key, height)`. A storage value with no height is
// unfalsifiable: it cannot be re-read, re-derived or disagreed with. Carrying
// the height is what makes a snapshot evidence rather than a reading.
//
// `observed_at` is OURS and `height` is the CHAIN's, and they are not
// interchangeable. Pipelines does not preserve order across requests (measured
// 2026-08-16), so nothing downstream may infer sequence from arrival -- the
// height is the only ordering that means anything.
//
// ## Cadence is per item, and that is the whole cost control
//
// Storage reads are the poller's scarcest budget. `TotalIssuance` every block is
// wasteful; `Swap` pools once a day is useless. So cadence is declared per item
// rather than per lane, and the declaration is versioned: a cadence change is a
// change to what the archive MEANS at a height, and a reader comparing two
// spans needs to know the sampling changed under them.

import { z } from "zod";

/**
 * One storage reading, at one height.
 *
 * `value` is the SCALE-encoded bytes as hex, NOT a decoded figure. Decoding
 * belongs to whoever reads this, and storing a decode would freeze one
 * interpretation of a value whose type can change across a runtime upgrade --
 * the archive would then hold our 2026 reading of a 2027 type with no way to
 * tell. Hex is what the chain actually returned.
 *
 * `.strict()` because this is the shape the stream carries, and an unknown key
 * is silently STRIPPED at a Pipelines sink (measured 2026-08-16): the row lands
 * looking correct with a field missing, which nothing downstream can notice.
 */
export const StorageSnapshotRow = z
  .object({
    pallet: z.string().min(1).describe("Pallet name, e.g. `Swap`."),
    item: z.string().min(1).describe("Storage item name within the pallet."),
    /**
     * The map key, hex-encoded, or `""` for a plain (unkeyed) storage value.
     *
     * EMPTY STRING RATHER THAN NULL, and deliberately: the stream has no
     * null-vs-absent distinction, so a nullable key would make every plain
     * value a dropped row. A plain item genuinely has no key, and `""` says so
     * without asking the transport to carry a concept it does not have.
     */
    key: z.string().describe('Hex map key, or "" for a plain storage value.'),
    height: z
      .int()
      .min(0)
      .describe("Block height the value was read AT. The only ordering."),
    value: z
      .string()
      .describe("SCALE-encoded value as hex. Not decoded -- see the header."),
    observed_at: z
      .int()
      .min(0)
      .describe("Epoch ms when WE read it. Never a substitute for `height`."),
  })
  .strict();

export type StorageSnapshotRow = z.infer<typeof StorageSnapshotRow>;

/** One declared item and how often it is worth sampling. */
export interface StorageSnapshotItem {
  pallet: string;
  item: string;
  /**
   * Minutes between samples. A FLOOR, quantised up to whatever clock the
   * producer runs on -- the same contract as `ScheduledLane.everyMinutes`.
   */
  everyMinutes: number;
  /** Why this cadence, in terms of what the value does. */
  reason: string;
}

/**
 * The declaration's version.
 *
 * BUMPED WHENEVER AN ITEM OR A CADENCE CHANGES, because both change what the
 * archive means. A reader comparing a span sampled every 20 minutes against one
 * sampled hourly is comparing two different datasets, and nothing in the rows
 * themselves would say so.
 */
export const STORAGE_SNAPSHOT_VERSION = 1;

/**
 * The four pallets where a published figure currently has no observed check.
 *
 * DELIBERATELY NOT ALL 361. The gap is real but a list that tries to close it
 * in one move prices itself out of the poller's storage budget and lands
 * nothing. These four are the ones where we already publish a derived number:
 * every row here can be reconciled against something we serve, which makes the
 * lane falsifiable from its first pass rather than an archive nobody reads.
 */
export const STORAGE_SNAPSHOT_ITEMS: readonly StorageSnapshotItem[] = [
  {
    pallet: "Swap",
    item: "AlphaSqrtPrice",
    everyMinutes: 60,
    reason:
      "The AMM state behind `alpha_price_tao`, which we publish with no independent check. Hourly tracks a tempo without sampling inside one.",
  },
  {
    pallet: "Swap",
    item: "SwapV3Initialized",
    everyMinutes: 1440,
    reason:
      "A per-subnet initialisation flag that changes once ever. Daily is a liveness sample, not a series.",
  },
  {
    pallet: "Balances",
    item: "TotalIssuance",
    everyMinutes: 60,
    reason:
      "Chain-level supply, currently DERIVED rather than observed. Hourly is enough to bound emission arithmetic without reading every block.",
  },
  {
    pallet: "Balances",
    item: "InactiveIssuance",
    everyMinutes: 60,
    reason:
      "The other half of the supply identity. Sampled with TotalIssuance so the two are always attributable to one height.",
  },
  {
    pallet: "Commitments",
    item: "CommitmentOf",
    everyMinutes: 60,
    reason:
      "Commit-reveal state. We decode 7.35M of its events and hold none of its state, so a reveal cannot be checked against what was committed.",
  },
  {
    pallet: "Crowdloan",
    item: "Crowdloans",
    everyMinutes: 60,
    reason:
      "Already a first-class pallet in `account_events`; the state is what those events move.",
  },
];

/**
 * The declared items, in a stable order, as `pallet.item`.
 *
 * Sorted so a diff of the declaration reads as an addition rather than a
 * reshuffle, and so two producers reading this list schedule identically.
 */
export function storageSnapshotKeys(
  items: readonly StorageSnapshotItem[] = STORAGE_SNAPSHOT_ITEMS,
): string[] {
  return items.map(({ pallet, item }) => `${pallet}.${item}`).sort();
}
