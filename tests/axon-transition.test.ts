// The narrowing and the derivation must agree about what a loss is (#11394).
//
// These run on real Postgres because the defect they pin was invisible to
// every fixture-level test in the family. `deriveAxonRemovals` had correct
// unit tests for moved-unroutable; `loadAxonRemovals` had correct unit tests
// against an injected row list. Neither could see that the SQL between them
// never SELECTS a moved-unroutable slot, because neither ran the SQL.
//
// Measured on Neon 2026-08-16 before the fix: 224 confirmed removals over 30
// days, 145 reaching the derivation, 79 lost -- every one a move, 78 of them
// SN126, which served 50 removals against 128.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, test } from "vitest";

import { axonAddressSql, ROUTABLE_AXON_SQL } from "../src/axon-routable.ts";
import {
  AXON_LOSS_SQL,
  AXON_MOVED_SQL,
  AXON_SAME_HOTKEY_SQL,
  AXON_VIA_REUSE_SQL,
  axonSequenceSql,
} from "../src/axon-transition.ts";
import {
  deriveAxonRemovals,
  type NeuronAxonDayRow,
} from "../src/axon-removal-derivation.ts";
import { loadAxonRemovals } from "../src/axon-removals-loader.ts";
import { toPositionalPlaceholders } from "../src/pg-sql.ts";

describe("the shared fragments", () => {
  test("reachability comes from axon-routable, not a second spelling", () => {
    const sql = axonSequenceSql();
    assert.ok(
      sql.includes(`(${ROUTABLE_AXON_SQL}) AS routable`),
      "the current reading is the shared predicate verbatim",
    );
    assert.ok(
      sql.includes(`LAG(${ROUTABLE_AXON_SQL}) OVER w AS prev_routable`),
      "and so is the previous one",
    );
  });

  test("prev_address splits at the LAST colon, so IPv6 survives it", () => {
    // The watchdog counted distinct IPs with `split_part(prev_axon, ':', 1)`,
    // which reads `2607:fb90:...:1036:10000` as the host `2607` and merges
    // every IPv6 announcement into one bucket (#11379).
    const sql = axonSequenceSql();
    assert.ok(sql.includes(`LAG(${axonAddressSql("axon")}) OVER w`));
    assert.doesNotMatch(sql, /split_part/);
  });

  test("the extra predicate lands AFTER the date bound", () => {
    // Placeholder ORDER is the contract: the watchdog binds
    // `[sinceDate, ...netuids]`, so a predicate appended before the date bound
    // would bind a netuid as the date and never throw.
    const sql = axonSequenceSql("netuid IN (?,?)");
    assert.ok(
      sql.indexOf("snapshot_date >= ?") < sql.indexOf("netuid IN (?,?)"),
    );
    assert.match(sql, /WHERE snapshot_date >= \? AND netuid IN \(\?,\?\)/);
  });

  test("no predicate leaves no dangling AND", () => {
    assert.match(
      axonSequenceSql(),
      /WHERE snapshot_date >= \? WINDOW w AS \(PARTITION BY netuid, uid ORDER BY snapshot_date\)$/,
    );
  });

  test("a first reading is not a loss", () => {
    // `prev_routable` is NULL on the first row of a partition, and the
    // predicate must evaluate to NULL there rather than true -- otherwise
    // every slot's first appearance in the window reads as a teardown.
    assert.equal(AXON_LOSS_SQL, "prev_routable AND NOT routable");
  });

  test("reuse and same-hotkey partition the losses between them", () => {
    assert.equal(AXON_VIA_REUSE_SQL, "hotkey IS DISTINCT FROM prev_hotkey");
    assert.equal(AXON_SAME_HOTKEY_SQL, "hotkey = prev_hotkey");
    // IS DISTINCT FROM rather than <>, so a NULL hotkey on either side is
    // reuse rather than dropping out of both counts.
    assert.doesNotMatch(AXON_VIA_REUSE_SQL, /hotkey <> prev_hotkey/);
  });

  test("moved is about what is announced now, not what was", () => {
    assert.equal(AXON_MOVED_SQL, "axon IS NOT NULL AND axon <> ''");
  });
});

// ---------------------------------------------------------------------------
// Executed against Postgres.
// ---------------------------------------------------------------------------

const MIGRATIONS = ["migrations/neon/0007_hand_created_tables.sql"].map((f) =>
  fs.readFileSync(path.join(process.cwd(), f), "utf8"),
);

/** Fixed clock, so `isoDaysAgo(now, 30)` is a known date the fixtures sit in. */
const NOW = Date.UTC(2026, 7, 16);

/** The presence narrowing this replaced, kept as the positive control. */
const PRESENCE_NARROWING_SQL =
  "WITH windowed AS (" +
  "  SELECT netuid, uid, snapshot_date, hotkey, axon," +
  "         lag(axon) OVER (PARTITION BY netuid, uid ORDER BY snapshot_date) AS prev_axon" +
  "  FROM neuron_daily WHERE snapshot_date >= $1" +
  "), dropped AS (" +
  "  SELECT DISTINCT netuid, uid FROM windowed" +
  "  WHERE prev_axon IS NOT NULL AND prev_axon <> ''" +
  "    AND (axon IS NULL OR axon = '')" +
  ")" +
  " SELECT w.netuid, w.uid, w.snapshot_date, w.hotkey, w.axon" +
  " FROM windowed w JOIN dropped d ON d.netuid = w.netuid AND d.uid = w.uid" +
  " ORDER BY w.netuid, w.uid, w.snapshot_date";

let db: PGlite;

/** The `deps.query` seam, with `?` rewritten exactly as production does. */
const query = async (text: string, values: unknown[]) =>
  (await db.query(toPositionalPlaceholders(text), values as never[]))
    .rows as Record<string, unknown>[];

/**
 * Every shape the derivation distinguishes, one slot each.
 *
 * `uid 2` is the case the presence narrowing could not see: a miner that keeps
 * announcing and moves to RFC 5737 documentation space. Nothing about its
 * `axon` column is ever null, so `axon IS NULL` never matched it.
 */
const DAYS: Array<[number, number, string, string, string | null]> = [
  // uid 1 -- cleared the field, and stayed cleared. A removal.
  [7, 1, "2026-08-01", "hkA", "1.2.3.4:8091"],
  [7, 1, "2026-08-02", "hkA", null],
  [7, 1, "2026-08-03", "hkA", null],
  // uid 2 -- moved to documentation space, and stayed. Also a removal.
  [7, 2, "2026-08-01", "hkB", "5.6.7.8:8091"],
  [7, 2, "2026-08-02", "hkB", "192.0.2.1:8091"],
  [7, 2, "2026-08-03", "hkB", "192.0.2.1:8091"],
  // uid 3 -- came back on the next reading. A missed poll, not a teardown.
  [7, 3, "2026-08-01", "hkC", "9.9.9.9:8091"],
  [7, 3, "2026-08-02", "hkC", null],
  [7, 3, "2026-08-03", "hkC", "9.9.9.9:8091"],
  // uid 4 -- the slot changed hands. A deregistration, counted elsewhere.
  [7, 4, "2026-08-01", "hkD", "8.8.8.8:8091"],
  [7, 4, "2026-08-02", "hkE", null],
  [7, 4, "2026-08-03", "hkE", null],
  // uid 5 -- dropped on the newest day, with nothing after it. Pending.
  [7, 5, "2026-08-01", "hkF", "4.4.4.4:8091"],
  [7, 5, "2026-08-02", "hkF", null],
  // uid 6 -- never stopped. No transition at all.
  [7, 6, "2026-08-01", "hkG", "1.1.1.1:8091"],
  [7, 6, "2026-08-02", "hkG", "1.1.1.1:8091"],
  // uid 7 -- unroutable throughout. Never reachable, so nothing was lost.
  [7, 7, "2026-08-01", "hkH", "10.0.0.5:8091"],
  [7, 7, "2026-08-02", "hkH", null],
  // uid 8 -- IPv6, moved to link-local. A move the naive port split misreads.
  [8, 8, "2026-08-01", "hkI", "2607:fb90:1036:1:8091"],
  [8, 8, "2026-08-02", "hkI", "fe80::1:8091"],
  [8, 8, "2026-08-03", "hkI", "fe80::1:8091"],
];

const FULL_ROWS: NeuronAxonDayRow[] = DAYS.map(
  ([netuid, uid, snapshot_date, hotkey, axon]) => ({
    netuid,
    uid,
    snapshot_date,
    hotkey,
    axon,
  }),
);

beforeAll(async () => {
  db = new PGlite();
  for (const sql of MIGRATIONS) await db.exec(sql);
});

beforeEach(async () => {
  await db.exec("TRUNCATE neuron_daily");
  for (const [netuid, uid, snapshot_date, hotkey, axon] of DAYS) {
    await db.query(
      "INSERT INTO neuron_daily (netuid, uid, hotkey, axon, snapshot_date, captured_at, updated_at)" +
        " VALUES ($1,$2,$3,$4,$5,$6,$6)",
      [netuid, uid, hotkey, axon, snapshot_date, NOW] as never[],
    );
  }
});

describe("the narrowing, executed", () => {
  test("a slot that only ever MOVED reaches the derivation", async () => {
    const out = await loadAxonRemovals({}, { query, now: () => NOW });
    const moved = out!.removals.filter((r) => r.kind === "moved-unroutable");
    assert.deepEqual(
      moved.map((r) => `${r.netuid}:${r.uid}:${r.current_axon}`),
      ["7:2:192.0.2.1:8091", "8:8:fe80::1:8091"],
      "both moves are served, including the IPv6 one",
    );
  });

  test("the presence narrowing it replaced could NOT see them", async () => {
    // The positive control. Without this the test above would pass on a
    // narrowing that never changed, because every OTHER shape survives both.
    const rows = (
      await db.query(PRESENCE_NARROWING_SQL, ["2026-07-17"] as never[])
    ).rows as NeuronAxonDayRow[];
    const derived = deriveAxonRemovals(rows, { lookbackDays: 30 });
    assert.deepEqual(
      derived.removals.filter((r) => r.kind === "moved-unroutable"),
      [],
      "the old predicate fetched no slot whose axon column never went null",
    );
    assert.equal(
      derived.derivation.moved_unroutable,
      0,
      "so the payload's own count of moves was structurally zero",
    );
  });

  test("narrowing loses nothing the full series would have found", async () => {
    // THE INVARIANT, stated the only way that catches the next drift: whatever
    // the derivation would conclude from every row in the window, it must also
    // conclude from the rows the SQL chose to fetch. The narrowing is allowed
    // to be wider (it over-fetches a slot the derivation then discards); it is
    // never allowed to be narrower.
    const narrowed = await loadAxonRemovals({}, { query, now: () => NOW });
    const full = deriveAxonRemovals(FULL_ROWS, { lookbackDays: 30 });
    assert.deepEqual(narrowed!.removals, full.removals);
    assert.deepEqual(narrowed!.derivation, full.derivation);
  });

  test("and the shapes that are not removals stay out", async () => {
    const out = await loadAxonRemovals({}, { query, now: () => NOW });
    assert.deepEqual(
      out!.removals.map((r) => `${r.netuid}:${r.uid}:${r.kind}`),
      [
        "7:1:stopped-announcing",
        "7:2:moved-unroutable",
        "8:8:moved-unroutable",
      ],
      "the flap, the reuse, the pending, the steady and the never-routable " +
        "slots are all absent",
    );
    assert.equal(out!.derivation.excluded_uid_reuse, 1);
    assert.equal(out!.derivation.pending_confirmation, 1);
    assert.equal(out!.derivation.moved_unroutable, 2);
  });
});

describe("the mechanism split, executed", () => {
  test("the watchdog's aggregate runs and partitions the same losses", async () => {
    // The watchdog builds this shape from the same fragments. Running it here
    // proves the composed SQL parses and that the three counts partition the
    // losses rather than overlapping -- `via_reuse + same_hotkey` is every
    // loss, and `moved_unroutable` is a subset of `same_hotkey`.
    const same = `${AXON_LOSS_SQL} AND ${AXON_SAME_HOTKEY_SQL}`;
    const sql =
      `WITH seq AS (${axonSequenceSql("netuid IN (?)")}) ` +
      "SELECT netuid, " +
      `COUNT(*) FILTER (WHERE ${AXON_LOSS_SQL} AND ${AXON_VIA_REUSE_SQL}) AS via_reuse, ` +
      `COUNT(*) FILTER (WHERE ${same}) AS same_hotkey, ` +
      `COUNT(*) FILTER (WHERE ${same} AND ${AXON_MOVED_SQL}) AS moved_unroutable, ` +
      `COUNT(DISTINCT prev_address) FILTER (WHERE ${same}) AS distinct_ips ` +
      "FROM seq GROUP BY netuid";
    const rows = await query(sql, ["2026-07-17", 7]);
    // Counts read back as numbers here: pglite parses int8, node-postgres
    // hands back strings. `loadAxonLossMechanisms` coerces either, and the
    // watchdog suite pins the string case against its own driver double.
    assert.deepEqual(rows, [
      {
        netuid: 7,
        // uid 4 changed hands.
        via_reuse: 1,
        // uids 1, 3 and 5 lost reachability with the same hotkey in the slot;
        // uid 2 moved. The watchdog counts the flap and the pending drop
        // because it explains TODAY's fall, which is the difference from the
        // archive and the reason the confirmation rule is not shared.
        same_hotkey: 4,
        moved_unroutable: 1,
        // 1.2.3.4, 9.9.9.9, 4.4.4.4 and 5.6.7.8 -- the addresses they left.
        distinct_ips: 4,
      },
    ]);
  });

  test("the IPv6 address is one host, not its first hex group", async () => {
    const rows = await query(
      `WITH seq AS (${axonSequenceSql("netuid IN (?)")}) ` +
        `SELECT prev_address FROM seq WHERE ${AXON_LOSS_SQL}`,
      ["2026-07-17", 8],
    );
    assert.deepEqual(rows, [{ prev_address: "2607:fb90:1036:1" }]);
  });
});
