// When a subnet was registered or deregistered (#10262).
//
// ## Where the signal comes from, and why it needs no producer change
//
// The obvious source would be `subnet_hyperparams` -- one row per live subnet.
// It cannot work: nothing prunes that table (#10259 is exactly that gap), so a
// deregistered subnet's row stays forever and its disappearance is never
// observable. Using it would be circular.
//
// `neurons` is the source. The metagraph lane rewrites EVERY netuid on every
// pass under one shared `captured_at` -- measured on production: 30,129 rows,
// 129 netuids, and `COUNT(DISTINCT captured_at) = 1`. So the netuid set at the
// newest stamp is the live subnet set, observed directly, and diffing two
// consecutive observations is the lifecycle event.
//
// ## The gate that makes this safe
//
// A netuid missing because the scan DIED is not a deregistration, and this
// table is append-only, so a false `deregistered` row is permanent. The scan
// does die: `lane_health` recorded `scan Delegates: Encountered an error
// iterating over storage` twice within one hour on 2026-08-08.
//
// So detection runs only when the pass cleared the same coverage floor
// `neurons-staleness` uses -- 80% of the expected netuids, the ratio already
// sized and justified there. Below it, this lane records `partial` and writes
// NOTHING. Writing nothing is always recoverable: the next complete pass sees
// the same difference and emits the same event. Writing a false deregistration
// is not.
//
// This is the same distinction #10236's registry resync had to make between an
// empty listing and an unreachable one -- absence is only meaningful when you
// know you looked properly.
import { SUBNET_LIFECYCLE_EVENTS } from "../schemas-src/routes/subnet-lifecycle.ts";
import {
  createPgSql,
  type HyperdriveLike,
  type WaitUntilLike,
} from "./pg-sql.ts";
import { laneHealthStore } from "./lane-health-store.ts";
import { recordLaneVerdict, type LaneHealthDb } from "./lane-health.ts";
import { readStore } from "./read-store.ts";
import {
  NEURONS_COVERAGE_FLOOR_NETUIDS,
  NEURONS_PASS_WINDOW_MS,
} from "./neurons-staleness-watchdog.ts";

export const SUBNET_LIFECYCLE_LANE = "subnet-lifecycle";

/** The event vocabulary is declared once, in the schema that publishes it.
 * Restating the union here would be a second source for a closed set -- the
 * class `validate:schema-vocabularies` exists to catch. */
export type SubnetLifecycleEventName = (typeof SUBNET_LIFECYCLE_EVENTS)[number];

export interface SubnetLifecycleEvent {
  netuid: number;
  event: SubnetLifecycleEventName;
  block_number: number | null;
  predates_capture: boolean;
}

export interface SubnetLifecycleDiff {
  events: SubnetLifecycleEvent[];
  /** True when this is the first run and the table is being seeded. */
  seeded: boolean;
}

/**
 * The rule alone: two netuid sets in, the events between them out.
 *
 * `known` is the set the table currently believes is live -- netuids whose
 * newest event is `registered`. `observed` is what the latest complete pass
 * actually saw.
 *
 * FIRST RUN SEEDS RATHER THAN REGISTERS. With an empty table every live subnet
 * would otherwise be reported as newly registered at the moment the lane was
 * deployed, which is false and, in an append-only table, permanently so. The
 * seed rows carry `predates_capture: true` and no block, which is the honest
 * statement: these existed before anything was watching.
 */
export function diffSubnetSets(
  known: ReadonlySet<number>,
  observed: ReadonlySet<number>,
  blockNumber: number | null = null,
): SubnetLifecycleDiff {
  const seeded = known.size === 0;
  const events: SubnetLifecycleEvent[] = [];
  for (const netuid of [...observed].sort((a, b) => a - b)) {
    if (known.has(netuid)) continue;
    events.push({
      netuid,
      event: "registered",
      // A seeded row cannot claim a block: the registration happened before
      // this lane existed, and the current head is not when it happened.
      block_number: seeded ? null : blockNumber,
      predates_capture: seeded,
    });
  }
  if (!seeded) {
    // Deregistrations are never emitted on the seeding run: an empty `known`
    // set means nothing is known to have left, not that everything did.
    for (const netuid of [...known].sort((a, b) => a - b)) {
      if (observed.has(netuid)) continue;
      events.push({
        netuid,
        event: "deregistered",
        block_number: blockNumber,
        predates_capture: false,
      });
    }
  }
  return { events, seeded };
}

/** One line naming the netuids, because a count sends nobody anywhere. */
export function lifecycleDetail(
  diff: SubnetLifecycleDiff,
  observedCount: number,
): string {
  if (diff.seeded) {
    return `seeded ${diff.events.length} subnet(s) as predating capture`;
  }
  if (diff.events.length === 0) return `no change, ${observedCount} subnet(s)`;
  const by = (name: SubnetLifecycleEventName) =>
    diff.events.filter((e) => e.event === name).map((e) => e.netuid);
  const parts: string[] = [];
  const reg = by("registered");
  const dereg = by("deregistered");
  if (reg.length > 0) parts.push(`registered ${reg.join(",")}`);
  if (dereg.length > 0) parts.push(`deregistered ${dereg.join(",")}`);
  return `${parts.join("; ")} (${observedCount} subnet(s) observed)`;
}

interface StatementClientLike {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<Row[]>;
}

export interface SubnetLifecycleDeps {
  laneHealthDb?: LaneHealthDb | null;
  now?: () => number;
  coverageFloor?: number;
  /** The write runner. `readStore`'s handle exposes all()/first() and no run()
   * -- it is a READ store, deliberately -- so the append needs its own. */
  sql?: { unsafe(text: string, values?: unknown[]): Promise<unknown> } | null;
  ctx?: WaitUntilLike | null;
}

/**
 * One tick. Returns a summary rather than throwing, like the rest of the family.
 */
export async function runSubnetLifecycleLane(
  env: Record<string, unknown> | null | undefined,
  deps: SubnetLifecycleDeps = {},
): Promise<Record<string, unknown>> {
  const now = deps.now ?? Date.now;
  const floor = deps.coverageFloor ?? NEURONS_COVERAGE_FLOOR_NETUIDS;
  const db = readStore(env, ["neurons", "subnet_lifecycle"]) as unknown as
    StatementClientLike | undefined;
  if (!db?.query) return { ok: false, reason: "no store bound" };

  const record = async (
    verdict: "ok" | "stale",
    detail: string,
  ): Promise<void> => {
    await recordLaneVerdict(laneHealthStore(env, deps.laneHealthDb), {
      lane: SUBNET_LIFECYCLE_LANE,
      verdict,
      age_ms: null,
      detail,
      checked_at: now(),
    });
  };

  try {
    // The netuid set at the newest stamp, plus that pass's block for
    // attribution. One statement: the window is the same 5 minutes
    // neurons-staleness uses to mean "the newest pass".
    const observedRows = await db.query(
      "SELECT DISTINCT netuid, MAX(block_number) AS block_number FROM neurons " +
        "WHERE captured_at >= (SELECT MAX(captured_at) FROM neurons) - ? " +
        "GROUP BY netuid",
      [NEURONS_PASS_WINDOW_MS],
    );

    const observed = new Set<number>();
    let blockNumber: number | null = null;
    for (const row of observedRows) {
      const netuid = Number(row.netuid);
      if (!Number.isInteger(netuid)) continue;
      observed.add(netuid);
      const block = Number(row.block_number);
      if (
        Number.isFinite(block) &&
        (blockNumber === null || block > blockNumber)
      ) {
        blockNumber = block;
      }
    }

    if (observed.size < floor) {
      // The gate. A short pass says nothing about what left.
      const detail = `partial: ${observed.size} netuid(s) under the ${floor} floor -- no events written`;
      await record("stale", detail);
      return {
        ok: true,
        alerted: true,
        reason: "partial",
        observed: observed.size,
      };
    }

    // What the table currently believes: netuids whose NEWEST event is a
    // registration. DISTINCT ON is the same shape loadLatestLaneHealth uses.
    const knownRows = await db.query(
      "SELECT DISTINCT ON (netuid) netuid, event FROM subnet_lifecycle " +
        "ORDER BY netuid, observed_at DESC, id DESC",
    );
    const known = new Set<number>();
    for (const row of knownRows) {
      if (String(row.event) !== "registered") continue;
      const netuid = Number(row.netuid);
      if (Number.isInteger(netuid)) known.add(netuid);
    }

    const diff = diffSubnetSets(known, observed, blockNumber);
    if (diff.events.length > 0) {
      const hyperdrive = env?.HYPERDRIVE as HyperdriveLike | undefined;
      const sql =
        deps.sql ??
        (hyperdrive?.connectionString && deps.ctx
          ? createPgSql(hyperdrive, deps.ctx)
          : hyperdrive?.connectionString
            ? createPgSql(hyperdrive, { waitUntil: () => {} })
            : null);
      if (!sql) {
        // Events to write and nowhere to write them is a FAILURE, not a quiet
        // pass: reporting `ok` here would claim the diff had been recorded.
        await record(
          "stale",
          `${diff.events.length} event(s) unwritten: no write runner`,
        );
        return {
          ok: false,
          reason: "no write runner",
          events: diff.events.length,
        };
      }
      for (const event of diff.events) {
        await sql.unsafe(
          "INSERT INTO subnet_lifecycle (netuid, event, block_number, observed_at, predates_capture)" +
            " VALUES ($1, $2, $3, $4, $5)",
          [
            event.netuid,
            event.event,
            event.block_number,
            now(),
            event.predates_capture,
          ],
        );
      }
    }

    const detail = lifecycleDetail(diff, observed.size);
    await record("ok", detail);
    return {
      ok: true,
      alerted: false,
      seeded: diff.seeded,
      events: diff.events.length,
      observed: observed.size,
    };
  } catch (err) {
    return {
      ok: false,
      reason: "query_failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
