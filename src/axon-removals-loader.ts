// Reading the axon-removal derivation out of `neuron_daily` (#10805).
//
// ## Why the work is split the way it is
//
// The rules that decide what counts as a removal live in ONE place --
// src/axon-removal-derivation.ts -- and this module does not restate them.
// That matters more than it looks: the rules are the whole feed. Subtracting
// UID reuse is the difference between 94 removals and 1,584, and requiring a
// second absent reading is the difference between a teardown and a missed
// poll. Two implementations of that, one in SQL and one in TypeScript, is two
// answers waiting to disagree -- and I had exactly that disagreement while
// building this (19 vs 14), from measuring with one rule and implementing
// another.
//
// So SQL does only what SQL is for: narrowing. It finds the slots that lost a
// REACHABLE axon at any point in the window and returns those slots' day
// series. Everything else -- the hotkey test, the confirmation test, the
// pending accounting -- happens in the derivation module, on rows it already
// has tests for.
//
// ## The narrowing has to move whenever the rule does
//
// It did not, once, and the cost was measurable. #11399 widened the derivation
// from a populated axon to a reachable one and left this predicate on presence,
// so a slot that only ever moved routable -> unroutable was never fetched and
// the widened rule never saw it: 79 of 224 confirmed removals over 30 days, all
// of them moves, SN126 serving 50 against 128. Both ends now read the predicate
// out of src/axon-transition.ts, which carries the measurement and the reason.
//
// ## The narrowing is what makes this affordable
//
// The window holds ~936,000 neuron-days network-wide, which no Worker should
// pull. Slots that dropped an axon at all are ~1,584 over 30 days, so their
// series is ~49,000 rows -- measured, not estimated: 47,616 rows for the six
// subnets used to verify the derivation. The expensive predicate runs in
// Postgres against the index; the cheap logic runs where it is tested.
import {
  deriveAxonRemovals,
  type DerivedAxonRemovals,
  type NeuronAxonDayRow,
} from "./axon-removal-derivation.ts";
import { readStore } from "./read-store.ts";
import { AXON_LOSS_SQL, axonSequenceSql } from "./axon-transition.ts";
import {
  axonSequenceD1Sql,
  axonProjectionReady,
} from "./axon-transition-d1.ts";
import { selectedD1Store } from "./d1-store.ts";

/** Days of `neuron_daily` to pull. The widest window any route offers. */
export const AXON_REMOVALS_LOOKBACK_DAYS = 30;

/**
 * One subnet's rollup, in the shape `buildChainAxonRemovals` already takes.
 *
 * A `type` and not an `interface`: the builders take `Record<string, unknown>[]`,
 * and an interface has no implicit index signature, so naming this as one would
 * oblige every call site to assert. Same reason as ArtifactSizeEntry in
 * scripts/build-artifacts.ts.
 */
export type AxonRemovalSubnetRow = {
  netuid: number;
  distinct_removers: number;
  removals: number;
};

export interface AxonRemovalsRollup {
  subnets: AxonRemovalSubnetRow[];
  /** Distinct hotkeys that removed an axon anywhere, and the newest removal. */
  network: { distinct_removers: number; newest_observed: string | null };
  derivation: DerivedAxonRemovals["derivation"];
  removals: DerivedAxonRemovals["removals"];
}

/**
 * The day series for every slot that lost a reachable axon in the window.
 *
 * The inner query is the narrowing, and the outer query returns the matching
 * slots WHOLE, because the derivation needs the readings on either side to tell
 * a teardown from a missed poll. It projects only the five columns
 * `NeuronAxonDayRow` names: the sequence carries `routable` and `prev_*` for
 * the predicate's benefit, and re-deciding reachability in the derivation from
 * the raw `axon` keeps `isRoutableAxon` the one place that answers it.
 */
function candidateSlotsSql(sequence: string): string {
  return (
    `WITH windowed AS MATERIALIZED (${sequence}), dropped AS (` +
    ` SELECT DISTINCT netuid, uid FROM windowed WHERE ${AXON_LOSS_SQL}` +
    ")" +
    " SELECT w.netuid, w.uid, w.snapshot_date, w.hotkey, w.axon" +
    " FROM windowed w JOIN dropped d ON d.netuid = w.netuid AND d.uid = w.uid" +
    " ORDER BY w.netuid, w.uid, w.snapshot_date"
  );
}
const CANDIDATE_SLOTS_SQL = candidateSlotsSql(axonSequenceSql());

export interface AxonRemovalsLoadDeps {
  /** Injectable for tests; production reads Neon through `readStore`. */
  query?: (sql: string, params: unknown[]) => Promise<unknown>;
  now?: () => number;
  /** Subnet cards consume only this subnet, so D1 need not scan the network. */
  netuid?: number;
}

/** `YYYY-MM-DD`, `days` before `nowMs`. */
export function isoDaysAgo(nowMs: number, days: number): string {
  return new Date(nowMs - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Derived removals, rolled up per subnet.
 *
 * Returns null when there is no store to read -- the caller keeps its existing
 * schema-stable empty rather than turning an unbound binding into "no removals
 * happened", which is the confident-zero this whole family is trying to stop
 * publishing.
 */
export async function loadAxonRemovals(
  env: unknown,
  deps: AxonRemovalsLoadDeps = {},
): Promise<AxonRemovalsRollup | null> {
  const now = deps.now ?? Date.now;
  let rows: unknown;
  if (deps.query) {
    rows = await deps.query(CANDIDATE_SLOTS_SQL, [
      isoDaysAgo(now(), AXON_REMOVALS_LOOKBACK_DAYS),
    ]);
  } else {
    const native = selectedD1Store(env, ["neuron_daily"]);
    const db = native ?? readStore(env, ["neuron_daily"]);
    if (!db) return null;
    const cutoff = isoDaysAgo(now(), AXON_REMOVALS_LOOKBACK_DAYS);
    if (native) {
      const indexed = await axonProjectionReady(native.query);
      const subnets =
        deps.netuid === undefined
          ? await native.query<{ netuid: number }>(
              "SELECT DISTINCT netuid FROM neuron_daily_documents WHERE day>=? ORDER BY netuid",
              [cutoff],
            )
          : [{ netuid: deps.netuid }];
      const collected: NeuronAxonDayRow[] = [];
      // Windows partition by (netuid, uid), so subnet reads are equivalent.
      // Yield D1 between subnets instead of holding its single writer behind
      // one network-wide window sort for tens of seconds.
      const statement = candidateSlotsSql(
        axonSequenceD1Sql("AND d.netuid=?", indexed),
      );
      for (const { netuid } of subnets)
        collected.push(
          ...(await native.query<NeuronAxonDayRow>(statement, [
            cutoff,
            netuid,
          ])),
        );
      rows = collected;
    } else rows = await db.query(CANDIDATE_SLOTS_SQL, [cutoff]);
  }

  const derived = deriveAxonRemovals(rows as NeuronAxonDayRow[] | null, {
    lookbackDays: AXON_REMOVALS_LOOKBACK_DAYS,
  });

  // Per subnet: how many removals, and how many DISTINCT hotkeys did them.
  // Distinct removers is the honest denominator -- one operator tearing down
  // forty miners is one actor, and the builder's removals_per_remover is what
  // says so.
  const perNetuid = new Map<
    number,
    { removals: number; hotkeys: Set<string> }
  >();
  const networkHotkeys = new Set<string>();
  let newest: string | null = null;
  for (const removal of derived.removals) {
    const bucket = perNetuid.get(removal.netuid) ?? {
      removals: 0,
      hotkeys: new Set<string>(),
    };
    bucket.removals += 1;
    bucket.hotkeys.add(removal.hotkey);
    perNetuid.set(removal.netuid, bucket);
    networkHotkeys.add(removal.hotkey);
    if (newest === null || removal.removed_on > newest)
      newest = removal.removed_on;
  }

  return {
    subnets: [...perNetuid]
      .map(([netuid, bucket]) => ({
        netuid,
        distinct_removers: bucket.hotkeys.size,
        removals: bucket.removals,
      }))
      .sort((a, b) => b.removals - a.removals || a.netuid - b.netuid),
    network: {
      distinct_removers: networkHotkeys.size,
      newest_observed: newest,
    },
    derivation: derived.derivation,
    removals: derived.removals,
  };
}

/**
 * The single row `buildSubnetAxonRemovals` takes, for one subnet.
 *
 * Null when the rollup itself is null -- "no store" has to stay
 * distinguishable from "this subnet removed nothing", which is a real answer
 * and returns a zeroed row.
 */
export function subnetAxonRemovalRow(
  rollup: AxonRemovalsRollup | null,
  netuid: number,
): Record<string, unknown> | null {
  if (!rollup) return null;
  const mine = rollup.removals.filter((r) => r.netuid === netuid);
  const hotkeys = new Set(mine.map((r) => r.hotkey));
  return {
    distinct_removers: hotkeys.size,
    removals: mine.length,
    // The newest removal ON THIS SUBNET, not the network's -- an observed_at
    // borrowed from elsewhere would date this card to an event it did not
    // include.
    newest_observed: mine.reduce<string | null>(
      (newest, r) =>
        newest === null || r.removed_on > newest ? r.removed_on : newest,
      null,
    ),
  };
}

/**
 * Per-subnet rows for one account, as `buildAccountAxonRemovals` takes them.
 *
 * The account here is the HOTKEY that stopped announcing. `neuron_daily` names
 * the hotkey on the slot, so a coldkey's removals are not derivable from this
 * table alone -- an empty answer for a coldkey is honest, and the same one the
 * route gave before.
 */
export function accountAxonRemovalRows(
  rollup: AxonRemovalsRollup | null,
  ss58: string,
): Record<string, unknown>[] | null {
  if (!rollup) return null;
  const perNetuid = new Map<
    number,
    { removals: number; first: string; last: string }
  >();
  for (const removal of rollup.removals) {
    if (removal.hotkey !== ss58) continue;
    const bucket = perNetuid.get(removal.netuid);
    if (bucket) {
      bucket.removals += 1;
      if (removal.removed_on < bucket.first) bucket.first = removal.removed_on;
      if (removal.removed_on > bucket.last) bucket.last = removal.removed_on;
    } else {
      perNetuid.set(removal.netuid, {
        removals: 1,
        first: removal.removed_on,
        last: removal.removed_on,
      });
    }
  }
  return [...perNetuid].map(([netuid, bucket]) => ({
    netuid,
    removals: bucket.removals,
    first_observed: bucket.first,
    last_observed: bucket.last,
  }));
}
