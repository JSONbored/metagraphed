// What a coverage rule has to know about a table before it can be written
// correctly (#11183).
//
// Three properties decide the shape of a correct coverage query, and until now
// NONE of them was declared anywhere. Every watchdog re-derived them by reading
// its writer, and on 2026-08-13/14 three of the four got it wrong -- each
// alarming for hours on data that was correct:
//
//   * DOES IT PRUNE. `validator_nominator_counts` is keyed on (hotkey) and
//     never deletes, so a hotkey that loses its last nominator keeps its row.
//     Its expectation had been "read off production as the row count at the
//     newest captured_at" -- 112,245 accumulated rows against 21,547 hotkeys
//     actually on chain, a floor no correct pass could ever meet (#11166).
//
//   * HOW MANY PRODUCERS. `nominator_positions` has two, which is why it has a
//     `source` column at all. Unscoped, `MAX(captured_at)` is whichever ran
//     last, so a HEALTHY targeted `self-stake` run made the full `alpha` scan
//     look truncated (#11180).
//
//   * ROWS OR KEYS. Coldkeys hold wildly different numbers of positions, so a
//     scan that died after the largest delegators can show high ROW coverage
//     having missed most accounts. Coverage has to be counted in the unit the
//     pass is partial IN.
//
// NOT INTROSPECTABLE, which is why this is declared rather than snapshotted.
// Postgres knows the columns; it cannot know that one producer prunes only its
// own rows, or that a partial pass is partial in coldkeys. What IS checkable is
// that the declaration matches the schema, and scripts/validate-lane-topology.ts
// does exactly that against `generated/db/schema.json` -- so a column renamed
// upstream fails CI here instead of silently un-scoping a rule.
import { POSITION_SOURCE_ALPHA } from "./nominator-positions-neon-write.ts";
import { type ProducerLane } from "./producer-cadence.ts";

/** Coverage counted over whole rows rather than distinct keys. */
export const COVERAGE_UNIT_ROWS = "rows";

/**
 * One table's topology.
 *
 * A plain interface with `satisfies` below, matching producer-cadence.ts --
 * the sibling that owns the other half of this metadata and carries no Zod at
 * all. `schemas-src/` is for PUBLISHED contract components; a Zod schema here
 * would parse a compile-time constant against itself, which proves nothing the
 * type does not already. The check that has teeth is the declaration against
 * `generated/db/schema.json`, and that is schema-vs-schema, the house pattern.
 */
export interface LaneTableTopology {
  /**
   * Whether the writer deletes rows a pass did not refresh, and at what grain.
   *
   * `false` means the table ACCUMULATES: its row count is history, not
   * population, and must never be used as an expectation. `{ perKey }` means
   * the prune is scoped to the keys a batch contains -- which is why a partial
   * pass leaves mixed freshness rather than corruption.
   */
  readonly prunes: false | { readonly perKey: string };
  readonly producers: {
    /**
     * Which producer lanes write this table.
     *
     * `ProducerLane` from producer-cadence.ts, which already owns this
     * vocabulary and pairs each lane with its cadence. Naming lanes freshly
     * here would be a third spelling of a fact that already has two.
     */
    readonly lanes: readonly ProducerLane[];
    /** The column telling them apart IN THE TABLE; null when there is one. */
    readonly column: string | null;
    /**
     * The value the full-scan producer STAMPS in that column.
     *
     * Deliberately separate from `lanes`: the lane is `validator_nominators`
     * and the value it writes is `alpha`. Those are two vocabularies for one
     * producer and both already exist, so this records the pairing rather than
     * inventing a name that collapses them.
     */
    readonly fullScanValue: string | null;
  };
  /** The column whose DISTINCT count is coverage, or COVERAGE_UNIT_ROWS. */
  readonly coverageUnit: string;
  /** Where a correct expectation is measured. Prose, deliberately. */
  readonly populationSource: string;
}

/**
 * Every Neon table a staleness watchdog counts coverage over.
 *
 * `populationSource` says CHAIN wherever the answer is a property of the
 * network, because that is the rule the four bugs above all broke: an
 * expectation read off our own sink reproduces whatever that sink accumulated.
 */
export const LANE_TABLE_TOPOLOGY = {
  nominator_positions: {
    // Scoped to the coldkeys a batch contains: an unstaked position genuinely
    // stops existing, so that delete is correct, and a coldkey absent from the
    // pass is left untouched rather than emptied.
    prunes: { perKey: "coldkey" },
    producers: {
      lanes: ["validator_nominators", "self_stake"],
      column: "source",
      // The writer's own constant, imported rather than restated -- a second
      // copy here would be free to drift from the value actually stamped.
      fullScanValue: POSITION_SOURCE_ALPHA,
    },
    coverageUnit: "coldkey",
    populationSource:
      "chain: distinct coldkeys in SubtensorModule::Alpha with netuid != 0 and shares > 0 (21,263 on 2026-08-14)",
  },
  validator_nominator_counts: {
    prunes: false,
    // The same poller pass writes this and nominator_positions' alpha rows.
    producers: {
      lanes: ["validator_nominators"],
      column: null,
      fullScanValue: null,
    },
    coverageUnit: "hotkey",
    populationSource:
      "chain: distinct hotkeys in SubtensorModule::Alpha (21,547 on 2026-08-14)",
  },
  hotkey_alpha: {
    prunes: false,
    producers: { lanes: ["hotkey_alpha"], column: null, fullScanValue: null },
    coverageUnit: COVERAGE_UNIT_ROWS,
    populationSource:
      "nominator_positions: distinct (hotkey, netuid) the NEWEST pass references -- the sink stores only pools a position names, so the expectation moves with that ledger (17,292 live on chain 2026-08-14 against 35,073 accumulated in the table)",
  },
  account_balances: {
    prunes: false,
    producers: {
      lanes: ["account_balances"],
      column: null,
      fullScanValue: null,
    },
    coverageUnit: "ss58",
    // The one lane whose expectation only GROWS, and the reason a ratio copied
    // from its siblings would be wrong here.
    populationSource:
      "chain: accounts that have ever held a balance -- monotonic, unlike every other lane here",
  },
  neurons: {
    prunes: false,
    producers: { lanes: ["metagraph"], column: null, fullScanValue: null },
    coverageUnit: "netuid",
    populationSource: "chain: registered subnets and their UID counts",
  },
  // chain_detail_blocks is deliberately ABSENT. Its watchdog is a ticker
  // against an advancing block frontier, not a coverage rule over a population,
  // and `chain_detail` is not a ProducerLane -- it has no declared cadence.
  // Forcing a lane name in to satisfy this shape would invent the vocabulary
  // this module exists to avoid inventing. If it ever grows a coverage rule, it
  // needs a cadence declaration first.
} as const satisfies Record<string, LaneTableTopology>;

export type LaneTableName = keyof typeof LANE_TABLE_TOPOLOGY;

/**
 * One table's topology, or a throw.
 *
 * Throws rather than returning undefined because every caller is a rule that
 * would otherwise silently fall back to an unscoped query -- which is the
 * defect this module exists to remove.
 */
export function laneTableTopology(table: LaneTableName): LaneTableTopology {
  const topology = LANE_TABLE_TOPOLOGY[table];
  if (!topology) throw new Error(`no declared topology for ${table}`);
  return topology;
}

/**
 * The producer whose completeness a coverage rule over `table` judges.
 *
 * THROWS on a table that declares several producers and names no full scan,
 * rather than returning null for the caller to handle. A rule that received
 * null would have to choose between scoping to nothing and scoping to
 * everything, and "everything" is the unscoped read that made a healthy
 * self-stake run look like a truncated alpha scan (#11180). Failing here is
 * loud; that fallback was not.
 */
export function resolveFullScan(
  topology: LaneTableTopology,
  label: string,
): string | null {
  const { producers } = topology;
  if (producers.fullScanValue) return producers.fullScanValue;
  // One producer writes everything, so there is nothing to scope on and null is
  // the honest answer -- unlike the several-producer case below, where null
  // would mean "scope to everything" and reintroduce #11180.
  if (producers.lanes.length === 1) return null;
  throw new Error(
    `${label} declares ${producers.lanes.length} producer lanes and no fullScanValue, so a coverage rule cannot know whose pass it is judging`,
  );
}

export function fullScanProducer(table: LaneTableName): string | null {
  return resolveFullScan(laneTableTopology(table), table);
}

/**
 * The value a SCOPED coverage read must match, for a table that has a
 * discriminator.
 *
 * Separate from `fullScanProducer` because null means two different things
 * there: "nothing to scope on" for a single-producer table, and "I cannot tell"
 * for an ambiguous one. A caller building `WHERE source = ?` can use neither --
 * binding null matches no rows at all, so the rule would report zero coverage
 * forever, which looks exactly like the truncated pass this all started with.
 */
export function requireFullScanValue(table: LaneTableName): string {
  const value = fullScanProducer(table);
  if (!value) {
    throw new Error(
      `${table} declares no discriminated full-scan producer, so a scoped coverage read cannot be built for it`,
    );
  }
  return value;
}
