// The watchdog for a mirror lane that never fires (src/neon-mirror-watchdog.ts).
//
// The property this file exists for is the one that makes a watchdog useful
// rather than ignorable: it must separate a DEMONSTRABLE fault from an absence
// it cannot interpret.
//
//   * a mirror that reported and then fell behind its table -> `stale`
//   * a mirror that never reported at all -> NAMED, never alarmed, because it
//     is indistinguishable from a producer that has not run since the mirror
//     deployed. All four ledger lanes were in exactly that state on
//     2026-08-07, and alarming them would have been an alarm on a working
//     system.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import {
  describeMirrorLags,
  MIRROR_LAG_THRESHOLD_MS,
  MIRROR_LANE_TABLES,
  mirrorFreshnessSql,
  mirrorLags,
  NEON_MIRROR_LAG_LANE,
  runNeonMirrorWatchdog,
} from "../src/neon-mirror-watchdog.ts";
import { neonDualWriteLanes } from "../src/neon-write.ts";

const HOUR = 60 * 60 * 1000;
const NOW = 1_785_800_000_000;

function fakeDb(
  rows: unknown[] | null,
  laneRows: unknown[] = [],
  opts: { noResultsKey?: boolean; throwNonError?: boolean } = {},
) {
  const calls: string[] = [];
  return {
    calls,
    db: {
      prepare(sql: string) {
        calls.push(sql);
        return {
          async all() {
            if (sql.startsWith("SELECT lane")) return { results: laneRows };
            if (opts.throwNonError) throw "connection terminated";
            if (rows === null) throw new Error("D1_ERROR: overloaded");
            return opts.noResultsKey ? {} : { results: rows };
          },
          bind(...values: unknown[]) {
            return {
              async run() {
                calls.push(`RUN ${sql} ${JSON.stringify(values.slice(0, 4))}`);
              },
              async all() {
                return { results: [] };
              },
            };
          },
        };
      },
    },
  };
}

describe("MIRROR_LANE_TABLES", () => {
  test("covers every lane the deployed flag can name", () => {
    // Built from the mirror plans rather than restated, so a lane added to a
    // plan cannot be left unwatched here. This asserts the live config too:
    // a lane named in NEON_DUAL_WRITE_LANES with no table pairing would be
    // mirrored and unmonitored, which is the state this watchdog exists to end.
    const deployed = neonDualWriteLanes({
      NEON_DUAL_WRITE_LANES:
        "neurons,nominator-positions,account-balances,hotkey-alpha,validator-nominator-counts",
    });
    for (const lane of deployed) {
      assert.ok(
        MIRROR_LANE_TABLES[lane],
        `${lane} is mirrored but has no table to be checked against`,
      );
    }
  });

  test("pairs each lane with the table whose freshness proves it ran", () => {
    assert.equal(MIRROR_LANE_TABLES["account-balances"], "account_balances");
    assert.equal(MIRROR_LANE_TABLES["hotkey-alpha"], "hotkey_alpha");
    assert.equal(
      MIRROR_LANE_TABLES["validator-nominator-counts"],
      "validator_nominator_counts",
    );
    // The one with NO writer-side lane at all, which is why this pairs against
    // tables rather than against lane names.
    assert.equal(
      MIRROR_LANE_TABLES["nominator-positions"],
      "nominator_positions",
    );
    assert.equal(MIRROR_LANE_TABLES.neuron_daily, "neuron_daily");
  });
});

describe("mirrorFreshnessSql", () => {
  test("asks every table in ONE statement", () => {
    const sql = mirrorFreshnessSql(["a", "b"]);
    assert.equal(
      sql,
      "SELECT 'a' AS t, MAX(captured_at) AS mx FROM a UNION ALL " +
        "SELECT 'b' AS t, MAX(captured_at) AS mx FROM b",
    );
  });
});

describe("mirrorLags", () => {
  const tables = { alpha: "t_alpha", beta: "t_beta" };
  const watched = new Set(["alpha", "beta"]);

  test("a mirror that reported and fell behind its table is LAGGING", () => {
    const survey = mirrorLags(
      tables,
      watched,
      new Map([["t_alpha", NOW]]),
      new Map([["neon:alpha", NOW - 3 * HOUR]]),
      HOUR,
    );
    assert.equal(survey.lagging.length, 1);
    assert.equal(survey.lagging[0].lane, "alpha");
    assert.equal(survey.lagging[0].lagMs, 3 * HOUR);
    assert.deepEqual(survey.neverMirrored, []);
  });

  test("a mirror that NEVER reported is named, never alarmed", () => {
    // The correction this file exists for. A never-mirrored lane is
    // indistinguishable from a producer that has not run since the mirror
    // deployed -- which was true of all four ledger lanes on 2026-08-07.
    const survey = mirrorLags(
      tables,
      watched,
      new Map([["t_alpha", NOW - 5 * HOUR]]),
      new Map(),
      HOUR,
    );
    assert.deepEqual(survey.lagging, [], "never-mirrored must NOT be a fault");
    assert.equal(survey.neverMirrored.length, 1);
    assert.equal(survey.neverMirrored[0].lane, "alpha");
    assert.equal(survey.neverMirrored[0].mirrorAt, null);
  });

  test("a mirror current with its table is neither", () => {
    const survey = mirrorLags(
      tables,
      watched,
      new Map([["t_alpha", NOW]]),
      new Map([["neon:alpha", NOW]]),
      HOUR,
    );
    assert.deepEqual(survey, { lagging: [], neverMirrored: [] });
  });

  test("a mirror NEWER than its table is not a lag", () => {
    // The mirror writes in the same request, and clocks are not exact. A
    // negative gap is health, not a fault.
    const survey = mirrorLags(
      tables,
      watched,
      new Map([["t_alpha", NOW - HOUR]]),
      new Map([["neon:alpha", NOW]]),
      HOUR,
    );
    assert.deepEqual(survey.lagging, []);
  });

  test("a gap under the threshold is tolerated", () => {
    const survey = mirrorLags(
      tables,
      watched,
      new Map([["t_alpha", NOW]]),
      new Map([["neon:alpha", NOW - HOUR + 1]]),
      HOUR,
    );
    assert.deepEqual(survey.lagging, []);
  });

  test("a lane the flag does not name is ignored entirely", () => {
    // Reporting it would make this watchdog loud about the configuration
    // working as intended.
    const survey = mirrorLags(
      tables,
      new Set(["alpha"]),
      new Map([
        ["t_alpha", NOW],
        ["t_beta", NOW],
      ]),
      new Map(),
      HOUR,
    );
    assert.deepEqual(
      survey.neverMirrored.map((l) => l.lane),
      ["alpha"],
    );
  });

  test("a table nobody has written proves nothing about its mirror", () => {
    // Absence of evidence, not evidence of a fault -- the same distinction
    // lane-health's own `staleLanes` makes for an `unknown` verdict.
    const survey = mirrorLags(tables, watched, new Map(), new Map(), HOUR);
    assert.deepEqual(survey, { lagging: [], neverMirrored: [] });
  });

  test("lagging is sorted worst first, never-mirrored by name", () => {
    const survey = mirrorLags(
      { a: "t_a", b: "t_b", c: "t_c", d: "t_d" },
      new Set(["a", "b", "c", "d"]),
      new Map([
        ["t_a", NOW],
        ["t_b", NOW],
        ["t_c", NOW],
        ["t_d", NOW],
      ]),
      new Map([
        ["neon:a", NOW - 2 * HOUR],
        ["neon:b", NOW - 9 * HOUR],
      ]),
      HOUR,
    );
    assert.deepEqual(
      survey.lagging.map((l) => l.lane),
      ["b", "a"],
    );
    assert.deepEqual(
      survey.neverMirrored.map((l) => l.lane),
      ["c", "d"],
    );
  });
});

describe("describeMirrorLags", () => {
  test("reports lag in hours and names the never-mirrored separately", () => {
    assert.equal(
      describeMirrorLags({ lagging: [], neverMirrored: [] }),
      "every mirror is current with its table",
    );
    assert.equal(
      describeMirrorLags({
        lagging: [
          {
            lane: "hotkey-alpha",
            table: "hotkey_alpha",
            tableAt: NOW,
            mirrorAt: NOW - 3 * HOUR,
            lagMs: 3 * HOUR,
          },
        ],
        neverMirrored: [
          {
            lane: "nominator-positions",
            table: "nominator_positions",
            tableAt: NOW,
            mirrorAt: null,
            lagMs: 0,
          },
        ],
      }),
      "hotkey-alpha: 3.0h behind hotkey_alpha | " +
        "never mirrored (not alarmed): nominator-positions",
    );
  });
});

describe("runNeonMirrorWatchdog", () => {
  test("does nothing until a lane is mirrored", async () => {
    for (const env of [undefined, null, {}, { NEON_DUAL_WRITE_LANES: "" }]) {
      assert.deepEqual(await runNeonMirrorWatchdog(env), { attempted: false });
    }
  });

  test("a flag naming only unknown lanes has no table to ask about", async () => {
    const spy = fakeDb([]);
    assert.deepEqual(
      await runNeonMirrorWatchdog(
        { NEON_DUAL_WRITE_LANES: "not-a-lane" },
        { db: spy.db, laneHealthDb: spy.db },
      ),
      { attempted: false },
    );
    assert.equal(spy.calls.length, 0);
  });

  test("records OK when every mirror is current", async () => {
    const spy = fakeDb(
      [{ t: "hotkey_alpha", mx: NOW }],
      [
        {
          lane: "neon:hotkey-alpha",
          verdict: "ok",
          age_ms: null,
          detail: "",
          checked_at: NOW,
        },
      ],
    );
    const out = await runNeonMirrorWatchdog(
      { NEON_DUAL_WRITE_LANES: "hotkey-alpha" },
      { db: spy.db, laneHealthDb: spy.db, now: () => NOW },
    );
    assert.deepEqual(out.survey, { lagging: [], neverMirrored: [] });
    assert.ok(
      spy.calls.some((c) => c.includes(`"${NEON_MIRROR_LAG_LANE}","ok"`)),
      `expected an ok verdict, got: ${spy.calls.filter((c) => c.startsWith("RUN")).join(" / ")}`,
    );
  });

  test("records STALE, with the worst lag as age_ms", async () => {
    const spy = fakeDb(
      [{ t: "hotkey_alpha", mx: NOW }],
      [
        {
          lane: "neon:hotkey-alpha",
          verdict: "ok",
          age_ms: null,
          detail: "",
          checked_at: NOW - 4 * HOUR,
        },
      ],
    );
    const out = await runNeonMirrorWatchdog(
      { NEON_DUAL_WRITE_LANES: "hotkey-alpha" },
      { db: spy.db, laneHealthDb: spy.db, now: () => NOW },
    );
    assert.equal(out.survey?.lagging.length, 1);
    assert.ok(
      spy.calls.some((c) => c.includes(`"${NEON_MIRROR_LAG_LANE}","stale"`)),
    );
  });

  test("a never-mirrored lane does NOT make the verdict stale", async () => {
    // The live 2026-08-07 case, and the whole reason this watchdog does not
    // simply alarm on absence.
    const spy = fakeDb([{ t: "hotkey_alpha", mx: NOW - 5 * HOUR }], []);
    const out = await runNeonMirrorWatchdog(
      { NEON_DUAL_WRITE_LANES: "hotkey-alpha" },
      { db: spy.db, laneHealthDb: spy.db, now: () => NOW },
    );
    assert.deepEqual(out.survey?.lagging, []);
    assert.equal(out.survey?.neverMirrored.length, 1);
    assert.ok(
      spy.calls.some((c) => c.includes(`"${NEON_MIRROR_LAG_LANE}","ok"`)),
      "a never-mirrored lane must not raise the verdict",
    );
    assert.ok(spy.calls.some((c) => c.includes("never mirrored")));
  });

  test("unreadable tables record UNKNOWN, never stale", async () => {
    // This watchdog reports on OTHER lanes' evidence. Claiming they are behind
    // because its own query failed would put a fabricated verdict where triage
    // reads one.
    const spy = fakeDb(null);
    const out = await runNeonMirrorWatchdog(
      { NEON_DUAL_WRITE_LANES: "hotkey-alpha" },
      { db: spy.db, laneHealthDb: spy.db, now: () => NOW },
    );
    assert.deepEqual(out, { attempted: true, reason: "freshness unreadable" });
    assert.ok(
      spy.calls.some((c) => c.includes(`"${NEON_MIRROR_LAG_LANE}","unknown"`)),
    );
  });

  test("an unbound D1 is unknown too, not a silent pass", async () => {
    const spy = fakeDb([]);
    const out = await runNeonMirrorWatchdog(
      { NEON_DUAL_WRITE_LANES: "hotkey-alpha" },
      { db: null, laneHealthDb: spy.db, now: () => NOW },
    );
    assert.equal(out.reason, "freshness unreadable");
  });

  test("rows with an unusable timestamp are dropped, not counted as zero", async () => {
    // MAX(captured_at) over an empty table is NULL, and `Number(null)` is 0 --
    // which passes Number.isFinite. Reading it as epoch 0 would report a
    // mirror that never followed a write that never happened. (Caught by this
    // test before the watchdog shipped.)
    const spy = fakeDb([
      { t: "hotkey_alpha", mx: null },
      { t: null, mx: NOW },
      { t: "hotkey_alpha", mx: "not-a-timestamp" },
    ]);
    const out = await runNeonMirrorWatchdog(
      { NEON_DUAL_WRITE_LANES: "hotkey-alpha" },
      { db: spy.db, laneHealthDb: spy.db, now: () => NOW },
    );
    assert.deepEqual(out.survey, { lagging: [], neverMirrored: [] });
  });

  test("a response carrying no `results` key is an empty survey, not a crash", async () => {
    const spy = fakeDb([], [], { noResultsKey: true });
    const out = await runNeonMirrorWatchdog(
      { NEON_DUAL_WRITE_LANES: "hotkey-alpha" },
      { db: spy.db, laneHealthDb: spy.db, now: () => NOW },
    );
    assert.deepEqual(out.survey, { lagging: [], neverMirrored: [] });
  });

  test("a rejection that is not an Error still reads in the verdict", async () => {
    const spy = fakeDb([], [], { throwNonError: true });
    await runNeonMirrorWatchdog(
      { NEON_DUAL_WRITE_LANES: "hotkey-alpha" },
      { db: spy.db, laneHealthDb: spy.db, now: () => NOW },
    );
    assert.ok(spy.calls.some((c) => c.includes("connection terminated")));
  });

  test("non-mirror lanes in lane_health are ignored", async () => {
    // lane_health holds every watchdog in the estate. Only `neon:` rows say
    // anything about a mirror.
    const spy = fakeDb(
      [{ t: "hotkey_alpha", mx: NOW }],
      [
        {
          lane: "metagraph",
          verdict: "ok",
          age_ms: null,
          detail: "",
          checked_at: NOW,
        },
        {
          lane: "neon:hotkey-alpha",
          verdict: "ok",
          age_ms: null,
          detail: "",
          checked_at: NOW,
        },
      ],
    );
    const out = await runNeonMirrorWatchdog(
      { NEON_DUAL_WRITE_LANES: "hotkey-alpha" },
      { db: spy.db, laneHealthDb: spy.db, now: () => NOW },
    );
    assert.deepEqual(out.survey, { lagging: [], neverMirrored: [] });
  });

  test("takes its D1 and clock off env, and its own threshold default", async () => {
    const spy = fakeDb([{ t: "hotkey_alpha", mx: Date.now() }], []);
    const out = await runNeonMirrorWatchdog({
      NEON_DUAL_WRITE_LANES: "hotkey-alpha",
      METAGRAPH_HEALTH_DB: spy.db,
    });
    assert.equal(out.attempted, true);
    assert.ok(MIRROR_LAG_THRESHOLD_MS > 0);
  });
});

describe("the deployed wiring", () => {
  const wrangler = readFileSync("wrangler.data.jsonc", "utf8");

  test("the cron the handler dispatches on is actually declared", async () => {
    // A constant the trigger list does not carry is a watchdog that never runs
    // -- which for THIS watchdog would be an unwatched watchdog, the exact
    // recursion #9698 was built to end.
    const { NEON_MIRROR_LAG_CRON } = await import("../workers/config.ts");
    assert.ok(
      wrangler.includes(`"${NEON_MIRROR_LAG_CRON}"`),
      `wrangler.data.jsonc declares no "${NEON_MIRROR_LAG_CRON}" cron`,
    );
  });

  test("every lane the deployed flag mirrors has a table pairing", () => {
    // Against the REAL flag value, not a fixture: a lane mirrored in production
    // with no pairing here would be written and unwatched.
    const named = (
      /"NEON_DUAL_WRITE_LANES":\s*"([^"]*)"/.exec(wrangler)?.[1] ?? ""
    )
      .split(",")
      .map((lane) => lane.trim())
      .filter(Boolean);
    assert.ok(named.length > 0, "expected the flag to name some lanes");
    for (const lane of named) {
      assert.ok(
        MIRROR_LANE_TABLES[lane],
        `${lane} is mirrored in production but has no table to check it against`,
      );
    }
  });
});
