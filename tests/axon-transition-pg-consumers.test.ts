// The native axon consumers (#13019 slice 2, consumers half): the announcement
// watchdog and the removals loader reading the composed tree, proven over a
// real PostgreSQL engine (PGlite). No decoder, so this suite runs everywhere.
//
// What it pins, beyond "the arm exists":
//   - the watchdog's whole tick -- day counts, finding, mechanism attribution
//     and verdict -- over the composed store, with a withdrawal shape seeded
//     large enough to clear the real baseline floor;
//   - readiness resolved ONCE per tick (the reason the mechanism loader now
//     takes a sequence builder instead of a dialect flag);
//   - the removals loader's whole-slot narrowing, including that an account
//     read keeps a replacement operator's readings;
//   - refusal before any read when a reading is not text;
//   - an incomplete binding throwing rather than falling back to another store.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, test } from "vitest";
import {
  runAxonAnnouncementWatchdog,
  loadAxonLossMechanisms,
  isoDaysAgo,
  AXON_BASELINE_DAYS,
} from "../src/axon-announcement-watchdog.ts";
import { loadAxonRemovalRows } from "../src/axon-removals-loader.ts";
import type { NeuronAxonDayRow } from "../src/axon-removal-derivation.ts";
import {
  createPgAxonTransition,
  axonSequencePgSql,
} from "../src/axon-transition-pg.ts";
import { selectedAxonTransitionStore } from "../src/axon-transition-store.ts";
import { toPositionalPlaceholders } from "../src/pg-sql.ts";

let db: PGlite;
let reads = 0;
const ROUTABLE = "198.18.0.";
const UIDS = 24;
/** Kept the axon on the last day; the rest of the slots lost it. */
const KEPT = 10;
const NOW = Date.parse("2026-08-10T12:00:00Z");
const DAYS = 9;
const day = (i: number) => `2026-08-${String(i + 2).padStart(2, "0")}`;

const store = () =>
  createPgAxonTransition({
    read: {
      async query<Row>(text: string, values: unknown[] = []) {
        reads += 1;
        return (await db.query<Row>(text, values)).rows;
      },
      async first() {
        return null;
      },
    },
  } as never);
const env = () => ({ AXON_TRANSITION_STORE: store() });
const run = (sql: string, values: unknown[] = []) =>
  db.query(toPositionalPlaceholders(sql), values);
/** The loader's own return type; `null` only when no store is bound, which
 * these fixtures always are -- so a null here is a defect, not a branch. */
const removalRows = async (
  deps: Parameters<typeof loadAxonRemovalRows>[1],
): Promise<NeuronAxonDayRow[]> => {
  const rows = await loadAxonRemovalRows(env(), deps, isoDaysAgo(NOW, DAYS));
  assert.ok(rows, "the composed store is bound, so the loader must answer");
  return rows;
};
const tagged = (axon: string | null) =>
  axon === null ? null : JSON.stringify(["text", JSON.stringify(axon)]);

beforeAll(async () => {
  db = new PGlite();
  for (const name of ["0024_neuron_documents.sql", "0044_mechanisms.sql"])
    await db.exec(
      readFileSync(
        new URL(`../migrations/postgres/${name}`, import.meta.url),
        "utf8",
      ),
    );
  // netuid 7: a withdrawal. Every slot announces for eight days; on the ninth,
  // every slot from KEPT up stops, keeping its own hotkey. 10/24 = 0.42, well
  // under AXON_DROP_RATIO, over a baseline of 24 -- above AXON_BASELINE_FLOOR,
  // which is why the fixture is this size rather than a handful of rows.
  for (let d = 0; d < DAYS; d += 1)
    for (let uid = 0; uid < UIDS; uid += 1) {
      const last = d === DAYS - 1;
      await db.query(
        `INSERT INTO app.neuron_daily_members(netuid,mechid,uid,snapshot_date,hotkey,coldkey,shard,axon_index,axon_indexed)
         VALUES (7,0,$1,$2,$3,'5C',0,$4,true)`,
        [
          uid,
          day(d),
          `hk${uid}`,
          tagged(last && uid >= KEPT ? null : `${ROUTABLE}${uid + 1}:8091`),
        ],
      );
    }
  // netuid 8: one slot that changes hands on the last day -- a reuse loss, and
  // a second subnet so the grouping is exercised. Too small to be evaluated,
  // which is itself correct: its baseline is under the floor.
  for (let d = 0; d < DAYS; d += 1)
    await db.query(
      `INSERT INTO app.neuron_daily_members(netuid,mechid,uid,snapshot_date,hotkey,coldkey,shard,axon_index,axon_indexed)
       VALUES (8,0,0,$1,$2,'5C',0,$3,true)`,
      [
        day(d),
        d === DAYS - 1 ? "hkNEW" : "hkOLD",
        tagged(d === DAYS - 1 ? null : "198.18.1.1:8091"),
      ],
    );
  // A mechid-1 row on the flagged subnet's last day: invisible to every read.
  await db.query(
    `INSERT INTO app.neuron_daily_members(netuid,mechid,uid,snapshot_date,hotkey,coldkey,shard,axon_index,axon_indexed)
     VALUES (7,1,0,$1,'5MECH','5C',0,$2,true)`,
    [day(DAYS - 1), tagged("198.18.9.9:8091")],
  );
});
afterAll(() => db.close());

test("the watchdog's whole tick reads the composed store and attributes the withdrawal", async () => {
  reads = 0;
  const tick = await runAxonAnnouncementWatchdog(env() as never, {
    now: () => NOW,
    recordException: async () => true,
  });
  assert.equal(tick.ok, true);
  assert.equal(tick.subnets_measured, 2, "both subnets' day counts came back");
  const findings = tick.findings as Record<string, unknown>[];
  assert.equal(findings.length, 1, "only netuid 7 clears the baseline floor");
  assert.equal(findings[0]!.netuid, 7);
  assert.equal(findings[0]!.withAxon, KEPT);
  assert.equal(findings[0]!.baseline, UIDS);
  assert.equal(findings[0]!.neurons, UIDS, "nobody deregistered");
  // The mechanism is what distinguishes this from churn, and it is the claim
  // the composed sequence had to answer: the same hotkeys stopped announcing.
  assert.equal(findings[0]!.lossesSameHotkey, UIDS - KEPT);
  assert.equal(findings[0]!.lossesViaReuse, 0);
  assert.equal(findings[0]!.lossesMovedUnroutable, 0, "cleared, not moved");
  assert.equal(findings[0]!.kind, "announcements-withdrawn");
  assert.equal(tick.alerted, true, "a withdrawal still pages");
});

test("readiness is resolved once per tick, not once per read", async () => {
  // The mechanism loader used to ask its own `axonProjectionReady` after the
  // day-counts read had already asked: two round trips for one fact. The tick
  // now resolves it once and hands the builder down, so the composed store
  // sees exactly four reads -- readiness, the two refusal probes, day counts
  // -- plus the one mechanism read for the flagged subnet.
  reads = 0;
  await runAxonAnnouncementWatchdog(env() as never, {
    now: () => NOW,
    recordException: async () => true,
  });
  assert.equal(reads, 4, `expected four store reads, saw ${reads}`);
});

test("mechanism counts over the composed sequence match the shared definition", async () => {
  const viaPgStore = await loadAxonLossMechanisms(
    store(),
    [7, 8],
    isoDaysAgo(NOW, AXON_BASELINE_DAYS + 1),
    (ids) =>
      axonSequencePgSql(`netuid IN (${ids.map(() => "?").join(",")})`, true),
  );
  assert.deepEqual(viaPgStore[7], {
    viaReuse: 0,
    sameHotkey: UIDS - KEPT,
    movedUnroutable: 0,
    distinctIps: UIDS - KEPT,
  });
  // netuid 8's loss is a handover: counted as reuse, never as a withdrawal,
  // and its distinct-address count stays out of the same-hotkey total.
  assert.deepEqual(viaPgStore[8], {
    viaReuse: 1,
    sameHotkey: 0,
    movedUnroutable: 0,
    distinctIps: 0,
  });
});

test("the removals loader returns whole slot histories, narrowed but never truncated", async () => {
  const all = await removalRows({});
  const slots = new Set(all.map((r) => `${r.netuid}/${r.uid}`));
  assert.equal(
    slots.size,
    UIDS - KEPT + 1,
    "every slot that lost a reachable axon, and only those",
  );
  // Exactly the five columns NeuronAxonDayRow names: the sequence carries
  // `routable` and the `prev_*` lags for the loss predicate's benefit, and
  // letting them leak would invite the derivation to re-use a reachability
  // verdict it is supposed to decide from the raw axon itself.
  assert.deepEqual(Object.keys(all[0]!).sort(), [
    "axon",
    "hotkey",
    "netuid",
    "snapshot_date",
    "uid",
  ]);
  // Whole histories: a selected slot carries all nine of its days, which is
  // what lets the derivation tell a teardown from a missed reading.
  const oneSlot = all.filter((r) => r.netuid === 7 && Number(r.uid) === KEPT);
  assert.equal(oneSlot.length, DAYS);

  const subnetOnly = await removalRows({ netuid: 8 });
  assert.deepEqual(
    [...new Set(subnetOnly.map((r) => Number(r.netuid)))],
    [8],
    "a subnet card reads its own subnet",
  );

  // An account read is narrowed by hotkey but must still return the
  // REPLACEMENT operator's readings on the slots it selects -- hiding them
  // could manufacture a removal the chain never saw.
  const account = await removalRows({ hotkey: "hkOLD" });
  assert.ok(account.length > 0, "the handover slot is selected");
  assert.ok(
    account.some((r) => r.hotkey === "hkNEW"),
    "the replacement operator's reading is retained on the selected slot",
  );
});

test("a non-text reading refuses before any consumer read", async () => {
  await db.query(
    `INSERT INTO app.neuron_daily_members(netuid,mechid,uid,snapshot_date,hotkey,coldkey,shard,axon_index,axon_indexed)
     VALUES (9,0,0,$1,'5I','5C',0,$2,true)`,
    [day(0), JSON.stringify(["integer", "8091"])],
  );
  await assert.rejects(removalRows({}), /non-text scalar.*integer/);
  // The watchdog turns the same refusal into its lane verdict rather than
  // throwing out of the tick: a cron that dies reports nothing at all.
  const tick = await runAxonAnnouncementWatchdog(env() as never, {
    now: () => NOW,
    recordException: async () => true,
  });
  assert.equal(tick.ok, false);
  assert.equal(tick.reason, "query_failed");
  await db.query("DELETE FROM app.neuron_daily_members WHERE netuid=9");
});

test("an incomplete binding throws instead of silently reading another store", async () => {
  assert.equal(selectedAxonTransitionStore({}), null);
  assert.equal(selectedAxonTransitionStore(null), null);
  assert.throws(
    () => selectedAxonTransitionStore({ AXON_TRANSITION_STORE: { query: 1 } }),
    /capability is incomplete/,
  );
  assert.throws(
    () =>
      selectedAxonTransitionStore({
        AXON_TRANSITION_STORE: { query: () => [], projectionReady: () => true },
      }),
    /capability is incomplete/,
  );
});

test("the mechid-1 row is invisible to the composed readings", async () => {
  const rows = (await run(
    `WITH seq AS (${axonSequencePgSql("netuid IN (?)", true)}) SELECT COUNT(*) AS n FROM seq`,
    [day(0), 7],
  )) as { rows: { n: string }[] };
  assert.equal(Number(rows.rows[0]!.n), UIDS * DAYS);
});
