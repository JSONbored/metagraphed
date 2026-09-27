// Derive removals from neuron_daily through the shared removal rules (#10805).
// SQL selects slots that lost a reachable axon; TypeScript distinguishes a
// confirmed teardown from a missed reading or UID reuse. Keep the transition
// predicate aligned with the derivation: populated -> empty alone misses moves
// to unroutable addresses (#11399).
//
// D1 reads small subnet groups and account reads first select relevant slots
// through the hotkey index. Every selected slot retains its whole day series,
// including other hotkeys, so narrowing cannot manufacture a removal by hiding
// a replacement operator or a later confirming/recovered reading.
import {
  deriveAxonRemovals,
  type DerivedAxonRemovals,
  type NeuronAxonDayRow,
  isoDaysAgo,
} from "./axon-removal-derivation.ts";
import { readStore } from "./read-store.ts";
import { AXON_LOSS_SQL, axonSequenceSql } from "./axon-transition.ts";
import {
  axonSequenceD1Sql,
  axonProjectionReady,
} from "./axon-transition-d1.ts";
import { selectedD1Store } from "./d1-store.ts";
import {
  readAxonRemovalProjection,
  writeAxonRemovalProjection,
  AXON_PROJECTION_LOOKBACK_DAYS,
} from "./axon-removals-projection.ts";
export { isoDaysAgo } from "./axon-removal-derivation.ts";

/** Baseline history to retain as transition context for shorter windows. */
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
  /** Validated requested window. Older rows remain transition context only. */
  windowDays?: number;
  /** Subnet cards consume only this subnet, so D1 need not scan the network. */
  netuid?: number;
  /** Account reads need whole slot histories, including replacement hotkeys. */
  hotkey?: string;
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
  const nowMs = (deps.now ?? Date.now)();
  // Keep the existing 30-day context for short windows and read wider account
  // windows in full, plus the preceding daily observation at the boundary.
  const lookbackDays = Math.max(
    AXON_REMOVALS_LOOKBACK_DAYS,
    (deps.windowDays ?? 0) + 1,
  );
  const cutoff = isoDaysAgo(nowMs, lookbackDays);
  const sinceDate =
    deps.windowDays === undefined
      ? undefined
      : isoDaysAgo(nowMs, deps.windowDays);
  const projected =
    !deps.query &&
    deps.windowDays !== undefined &&
    deps.netuid === undefined &&
    deps.hotkey === undefined
      ? await readAxonRemovalProjection(env, deps.windowDays, nowMs)
      : null;
  if (projected) return rollupAxonRemovals(projected);
  const rows = await loadAxonRemovalRows(env, deps, cutoff);
  if (rows === null) return null;
  return rollupAxonRemovals(
    deriveAxonRemovals(rows, {
      lookbackDays,
      sinceDate,
    }),
  );
}

/** Shared producer read; public requests use the compact projection when fresh. */
export async function loadAxonRemovalRows(
  env: unknown,
  deps: AxonRemovalsLoadDeps,
  cutoff: string,
): Promise<NeuronAxonDayRow[] | null> {
  let rows: unknown;
  if (deps.query) {
    rows = await deps.query(CANDIDATE_SLOTS_SQL, [cutoff]);
  } else {
    const native = selectedD1Store(env, ["neuron_daily"]);
    const db = native ?? readStore(env, ["neuron_daily"]);
    if (!db) return null;
    if (native) {
      const indexed = await axonProjectionReady(native.query);
      const subnets =
        deps.netuid !== undefined
          ? [{ netuid: deps.netuid }]
          : deps.hotkey !== undefined
            ? await native.query<{ netuid: number }>(
                "SELECT DISTINCT netuid FROM neuron_daily_members WHERE hotkey=? AND snapshot_date>=? ORDER BY netuid",
                [deps.hotkey, cutoff],
              )
            : await native.query<{ netuid: number }>(
                "SELECT DISTINCT netuid FROM neuron_daily_documents WHERE day>=? ORDER BY netuid",
                [cutoff],
              );
      const collected: NeuronAxonDayRow[] = [];
      // Windows partition by (netuid, uid), so grouping whole subnets keeps
      // exactly the same sequences. Four at a time cuts network-wide request
      // round trips by 75% while yielding D1 between bounded sorts. Account
      // reads remain one subnet at a time to preserve their UID narrowing.
      const groupSize = deps.hotkey === undefined ? 4 : 1;
      for (let start = 0; start < subnets.length; start += groupSize) {
        const group = subnets
          .slice(start, start + groupSize)
          .map(({ netuid }) => netuid);
        const statement = candidateSlotsSql(
          axonSequenceD1Sql(
            `AND d.netuid IN (${group.map(() => "?").join(",")})` +
              (deps.hotkey === undefined
                ? ""
                : " AND m.uid IN (SELECT uid FROM neuron_daily_members WHERE hotkey=? AND netuid=? AND snapshot_date>=?)"),
            indexed,
          ),
        );
        collected.push(
          ...(await native.query<NeuronAxonDayRow>(statement, [
            cutoff,
            ...group,
            ...(deps.hotkey === undefined
              ? []
              : [deps.hotkey, group[0], cutoff]),
          ])),
        );
      }
      rows = collected;
    } else rows = await db.query(CANDIDATE_SLOTS_SQL, [cutoff]);
  }

  return rows as NeuronAxonDayRow[] | null;
}

/** Roll up already classified transitions without scanning neuron history. */
export function rollupAxonRemovals(
  derived: DerivedAxonRemovals,
): AxonRemovalsRollup {
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

/** Reuse the existing projection tick; public reads never write or refresh. */
export async function refreshAxonRemovalProjection(
  env: unknown,
  nowMs = Date.now(),
): Promise<void> {
  if (!selectedD1Store(env, ["neuron_daily"])) return;
  const rows = await loadAxonRemovalRows(
    env,
    {},
    isoDaysAgo(nowMs, AXON_PROJECTION_LOOKBACK_DAYS),
  );
  if (rows === null) throw new Error("Axon projection source unavailable");
  await writeAxonRemovalProjection(env, rows, nowMs);
}
