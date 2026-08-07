// The lane-health READER (src/lane-alarm.ts).
//
// The load-bearing properties are all about restraint, because an alerting
// system's failure mode is being muted rather than being wrong:
//
//   * a lane must be stale CONTINUOUSLY to alarm -- a flicker must not,
//   * an alarm must not be re-opened while its issue is still open,
//   * an unreadable issue list must NOT be read as "nothing is open",
//   * and only an `ok` verdict closes -- `unknown` is not recovery.
//
// The silence detector gets the same scrutiny from the other direction: it must
// fire for a watchdog that stopped writing while its last verdict said `ok`,
// which is the fault that had no detector at all before this file.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  LANE_ALARM_MAX_OPENS_PER_TICK,
  LANE_ALARM_MIN_STALE_MS,
  LANE_ALARM_TITLE_PREFIX,
  LANE_CADENCE_SQL,
  LANE_STALE_RUN_SQL,
  laneAlarmGitHub,
  laneAlarmIssueBody,
  laneAlarmPlan,
  laneAlarmRecoveryComment,
  laneAlarmTitle,
  laneCadenceMs,
  laneSilenceThresholdMs,
  loadLaneCadence,
  loadLaneStaleRuns,
  runLaneAlarm,
  type LaneAlarm,
  type LaneAlarmGitHub,
} from "../src/lane-alarm.ts";
import type { LaneHealthRecord } from "../src/lane-health.ts";

const NOW = 1_785_800_000_000;
const HOUR = 60 * 60 * 1000;

function record(over: Partial<LaneHealthRecord> = {}): LaneHealthRecord {
  return {
    lane: "neurons-staleness",
    verdict: "stale",
    age_ms: 4 * HOUR,
    detail: "partial",
    checked_at: NOW - 1000,
    ...over,
  };
}

/** A D1 double: returns rows, or throws however asked. */
function fakeDb(rows: Record<string, unknown>[] | Error = []) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const answer = () => {
    if (rows instanceof Error) throw rows;
    return { results: rows };
  };
  return {
    calls,
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          calls.push({ sql, values });
          return {
            run: async () => ({}),
            first: async () => null,
            all: async () => answer(),
          };
        },
        all: async () => {
          calls.push({ sql, values: [] });
          return answer();
        },
      };
    },
  };
}

describe("laneCadenceMs", () => {
  test("averages the gaps between ticks", () => {
    // 5 verdicts spanning 60 minutes = 4 gaps of 15 minutes.
    assert.equal(
      laneCadenceMs({ n: 5, first: NOW - 60 * 60_000, last: NOW }),
      15 * 60_000,
    );
  });

  test("refuses to guess from too little history", () => {
    // Two samples is one gap, and a wrong cadence produces exactly the false
    // alarm the design is trying to avoid. Uncalibrated is the honest answer.
    assert.equal(laneCadenceMs({ n: 2, first: NOW - 60_000, last: NOW }), null);
  });

  test("refuses a zero-width span", () => {
    // Every verdict at the same instant: a real table state on the first tick
    // after a deploy, and a cadence of 0 would make the silence threshold 0.
    assert.equal(laneCadenceMs({ n: 5, first: NOW, last: NOW }), null);
  });
});

describe("laneSilenceThresholdMs", () => {
  test("three intervals for a slow lane", () => {
    assert.equal(laneSilenceThresholdMs(24 * HOUR), 72 * HOUR);
  });

  test("floors a fast lane, so a deploy is not an outage", () => {
    // tao-usd-index ticks every minute; three intervals would be 3 minutes.
    assert.equal(laneSilenceThresholdMs(60_000), 90 * 60_000);
  });
});

describe("laneAlarmPlan", () => {
  const base = {
    latest: {},
    runs: {},
    cadence: {},
    openAlarms: {},
    nowMs: NOW,
    minStaleMs: LANE_ALARM_MIN_STALE_MS,
  };

  test("alarms on a lane stale for longer than the threshold", () => {
    const plan = laneAlarmPlan({
      ...base,
      latest: { a: record({ lane: "a" }) },
      runs: { a: { since: NOW - 28 * HOUR, ticks: 112 } },
      cadence: { a: 15 * 60_000 },
    });
    assert.equal(plan.open.length, 1);
    assert.deepEqual(
      {
        lane: plan.open[0].lane,
        kind: plan.open[0].kind,
        ticks: plan.open[0].ticks,
        cadence: plan.open[0].cadence_ms,
      },
      { lane: "a", kind: "stale", ticks: 112, cadence: 15 * 60_000 },
    );
  });

  test("a one-tick flicker never reaches the threshold", () => {
    // chain-detail did this 64 times in one day while being healthy. If a blip
    // could alarm, the alarm would be muted within a week.
    const plan = laneAlarmPlan({
      ...base,
      latest: { a: record({ lane: "a" }) },
      runs: { a: { since: NOW - 60_000, ticks: 1 } },
    });
    assert.deepEqual(plan.open, []);
  });

  test("dates a stale lane from its newest verdict when no run row exists", () => {
    // The two reads are separate queries; a verdict can land between them.
    const plan = laneAlarmPlan({
      ...base,
      latest: { a: record({ lane: "a", checked_at: NOW - 3 * HOUR }) },
      runs: {},
    });
    assert.equal(plan.open.length, 1);
    assert.equal(plan.open[0].since, NOW - 3 * HOUR);
    assert.equal(plan.open[0].ticks, 1);
    assert.equal(plan.open[0].cadence_ms, null);
  });

  test("alarms on a SILENT lane whose last verdict said ok", () => {
    // The fault with no detector: staleLanes() sees nothing, because nothing it
    // can see is stale. The watchdog simply stopped writing.
    const plan = laneAlarmPlan({
      ...base,
      latest: {
        a: record({
          lane: "a",
          verdict: "ok",
          detail: null,
          checked_at: NOW - 6 * HOUR,
        }),
      },
      cadence: { a: 30 * 60_000 },
    });
    assert.equal(plan.open.length, 1);
    assert.equal(plan.open[0].kind, "silent");
    assert.equal(plan.open[0].ticks, 0);
  });

  test("a lane inside its own cadence is not silent", () => {
    const plan = laneAlarmPlan({
      ...base,
      latest: {
        a: record({ lane: "a", verdict: "ok", checked_at: NOW - 20 * 60_000 }),
      },
      cadence: { a: 15 * 60_000 },
    });
    assert.deepEqual(plan.open, []);
  });

  test("an uncalibrated lane is never called silent", () => {
    const plan = laneAlarmPlan({
      ...base,
      latest: {
        a: record({
          lane: "a",
          verdict: "ok",
          checked_at: NOW - 40 * 24 * HOUR,
        }),
      },
      cadence: {},
    });
    assert.deepEqual(plan.open, []);
  });

  test("a stale lane raises one alarm, not two", () => {
    // It is also, by definition, not writing recently -- but "stale" and "then
    // it stopped saying so" are one outage.
    const plan = laneAlarmPlan({
      ...base,
      latest: { a: record({ lane: "a", checked_at: NOW - 9 * HOUR }) },
      runs: { a: { since: NOW - 9 * HOUR, ticks: 30 } },
      cadence: { a: 15 * 60_000 },
    });
    assert.equal(plan.open.length, 1);
    assert.equal(plan.open[0].kind, "stale");
  });

  test("an `unknown` verdict is never STALE, but can still go silent", () => {
    const plan = laneAlarmPlan({
      ...base,
      latest: {
        a: record({
          lane: "a",
          verdict: "unknown",
          checked_at: NOW - 9 * HOUR,
        }),
      },
      cadence: { a: 15 * 60_000 },
    });
    // staleLanes() excludes `unknown`, so this cannot be a stale alarm. It is
    // 9 hours past a 15-minute cadence, though, so the silence detector still
    // reaches it -- which is the point: "the watchdog cannot evaluate this lane
    // and has now stopped trying" is exactly what needs reporting.
    assert.equal(plan.open.length, 1);
    assert.equal(plan.open[0].kind, "silent");
  });

  test("ignores a RETIRED lane whose last verdict is a week old", () => {
    // A retired lane's final row sits in lane_health until retention expires
    // it. If that row said `stale`, staleLanes() keeps returning it -- and the
    // alarm would re-raise a lane that no longer exists for 90 days.
    const plan = laneAlarmPlan({
      ...base,
      latest: { a: record({ lane: "a", checked_at: NOW - 9 * 24 * HOUR }) },
      runs: { a: { since: NOW - 30 * 24 * HOUR, ticks: 4000 } },
    });
    assert.deepEqual(plan.open, []);
    // And it cannot come back as `silent` either: the cadence read looks at the
    // same window, so a lane with nothing in it is uncalibrated.
    assert.equal(plan.suppressed, 0);
  });

  test("does not re-open a lane that already has an issue", () => {
    const plan = laneAlarmPlan({
      ...base,
      latest: { a: record({ lane: "a" }) },
      runs: { a: { since: NOW - 28 * HOUR, ticks: 112 } },
      openAlarms: { a: 4242 },
    });
    assert.deepEqual(plan.open, []);
    assert.equal(plan.suppressed, 0);
  });

  test("caps a platform-wide outage, and reports what it capped", () => {
    const latest: Record<string, LaneHealthRecord> = {};
    const runs: Record<string, { since: number; ticks: number }> = {};
    for (let i = 0; i < 9; i += 1) {
      const lane = `lane-${i}`;
      latest[lane] = record({ lane });
      // Descending start times, so the WORST are not the ones sorted first.
      runs[lane] = { since: NOW - (2 + i) * HOUR, ticks: 10 };
    }
    const plan = laneAlarmPlan({ ...base, latest, runs });
    assert.equal(plan.open.length, LANE_ALARM_MAX_OPENS_PER_TICK);
    assert.equal(plan.suppressed, 9 - LANE_ALARM_MAX_OPENS_PER_TICK);
    // Oldest-first: the longest-running fault must survive the cap.
    assert.equal(plan.open[0].lane, "lane-8");
  });

  test("closes an issue when its lane reports ok", () => {
    const plan = laneAlarmPlan({
      ...base,
      latest: { a: record({ lane: "a", verdict: "ok" }) },
      openAlarms: { a: 77 },
    });
    assert.deepEqual(
      plan.close.map((c) => ({ lane: c.lane, issue: c.issue })),
      [{ lane: "a", issue: 77 }],
    );
  });

  test("does NOT close on `unknown` -- absence of measurement is not recovery", () => {
    const plan = laneAlarmPlan({
      ...base,
      latest: { a: record({ lane: "a", verdict: "unknown" }) },
      openAlarms: { a: 77 },
    });
    assert.deepEqual(plan.close, []);
  });

  test("does NOT close a lane that has no record at all", () => {
    const plan = laneAlarmPlan({ ...base, openAlarms: { a: 77 } });
    assert.deepEqual(plan.close, []);
  });

  test("does not close a lane that is still stale", () => {
    const plan = laneAlarmPlan({
      ...base,
      latest: { a: record({ lane: "a" }) },
      runs: { a: { since: NOW - 28 * HOUR, ticks: 112 } },
      openAlarms: { a: 77 },
    });
    assert.deepEqual(plan.close, []);
  });
});

describe("laneAlarmIssueBody", () => {
  function alarm(over: Partial<LaneAlarm> = {}): LaneAlarm {
    return {
      lane: "neurons-staleness",
      kind: "stale",
      since: NOW - 28 * HOUR,
      ticks: 112,
      detail: "partial",
      age_ms: 4 * HOUR,
      cadence_ms: 15 * 60_000,
      ...over,
    };
  }

  test("a stale body names the duration, the tick count, and the reason", () => {
    const body = laneAlarmIssueBody(alarm(), NOW);
    assert.match(body, /reported \*\*stale\*\* on every tick/);
    assert.match(body, /28\.0h/);
    assert.match(body, /112 consecutive verdicts/);
    assert.match(body, /watchdog said \| `partial`/);
    assert.match(body, /observed cadence \| 15 min/);
    assert.match(body, /lane was behind by \| 4\.0h/);
    assert.match(body, /FROM lane_health WHERE lane = 'neurons-staleness'/);
  });

  test("a silent body says the watchdog stopped, and what it last said", () => {
    const body = laneAlarmIssueBody(
      alarm({ kind: "silent", ticks: 0, detail: "ok", age_ms: null }),
      NOW,
    );
    assert.match(body, /no verdict at all/);
    assert.match(body, /appears to have stopped running/);
    assert.doesNotMatch(body, /lane was behind by/);
  });

  test("a silent lane that never wrote a detail still reads correctly", () => {
    const body = laneAlarmIssueBody(
      alarm({ kind: "silent", detail: null, cadence_ms: null }),
      NOW,
    );
    assert.match(body, /last verdict it did write said `ok`/);
    assert.doesNotMatch(body, /observed cadence/);
    assert.doesNotMatch(body, /watchdog said/);
  });

  test("renders every duration scale", () => {
    assert.match(
      laneAlarmIssueBody(alarm({ since: NOW - 30_000 }), NOW),
      /30s/,
    );
    assert.match(
      laneAlarmIssueBody(alarm({ since: NOW - 20 * 60_000 }), NOW),
      /20 min/,
    );
    assert.match(
      laneAlarmIssueBody(alarm({ since: NOW - 5 * HOUR }), NOW),
      /5\.0h/,
    );
    assert.match(
      laneAlarmIssueBody(alarm({ since: NOW - 102 * HOUR }), NOW),
      /4\.3 days/,
    );
  });

  test("never renders a negative duration from a clock that disagrees", () => {
    // `since` comes from D1 and `now` from the Worker; they are different
    // clocks, and "-3s" in an alarm reads as a bug in the alarm.
    assert.match(laneAlarmIssueBody(alarm({ since: NOW + 3000 }), NOW), /0s/);
  });
});

describe("laneAlarmRecoveryComment", () => {
  test("states the recovery time and the verdict detail", () => {
    const comment = laneAlarmRecoveryComment(
      "a",
      record({ verdict: "ok", detail: "129 of 129 netuids" }),
    );
    assert.match(comment, /reported \*\*ok\*\*/);
    assert.match(comment, /129 of 129 netuids/);
  });

  test("reads cleanly when the watchdog wrote no detail", () => {
    const comment = laneAlarmRecoveryComment(
      "a",
      record({ verdict: "ok", detail: null }),
    );
    assert.match(comment, /Closing automatically\.$/);
  });
});

describe("loadLaneStaleRuns / loadLaneCadence", () => {
  test("read the current run and the observed cadence", async () => {
    const db = fakeDb([{ lane: "a", since: 10, ticks: 5 }]);
    assert.deepEqual(await loadLaneStaleRuns(db), {
      a: { since: 10, ticks: 5 },
    });
    assert.equal(db.calls[0].sql, LANE_STALE_RUN_SQL);

    const cadenceDb = fakeDb([
      { lane: "a", n: 5, first: NOW - 60 * 60_000, last: NOW },
    ]);
    assert.deepEqual(await loadLaneCadence(cadenceDb, NOW - 7 * 24 * HOUR), {
      a: 15 * 60_000,
    });
    assert.equal(cadenceDb.calls[0].sql, LANE_CADENCE_SQL);
    assert.deepEqual(cadenceDb.calls[0].values, [NOW - 7 * 24 * HOUR]);
  });

  test("skip a row with no lane name rather than keying on an empty string", async () => {
    assert.deepEqual(
      await loadLaneStaleRuns(fakeDb([{ since: 1, ticks: 1 }])),
      {},
    );
    assert.deepEqual(await loadLaneCadence(fakeDb([{ n: 5 }]), 0), {});
  });

  test("coerce an unreadable count to zero rather than NaN", async () => {
    // A NaN cadence compares false against every threshold, which would report
    // a dead watchdog healthy -- the same class of bug as #9530's NaN coverage.
    assert.deepEqual(
      await loadLaneStaleRuns(fakeDb([{ lane: "a", since: "x", ticks: null }])),
      { a: { since: 0, ticks: 0 } },
    );
  });

  test("treat a driver that answers with no rows key as empty", async () => {
    // D1 shims and older bindings have both answered `{}` and `null` here; a
    // reader that trusted `.results` would throw on the first such tick.
    const shim = {
      prepare: () => ({
        bind: () => ({
          run: async () => ({}),
          first: async () => null,
          all: async () => null,
        }),
        all: async () => ({}),
      }),
    };
    assert.deepEqual(await loadLaneStaleRuns(shim), {});
    assert.deepEqual(await loadLaneCadence(shim, 0), {});
  });

  test("return empty on a missing binding or a failing query", async () => {
    assert.deepEqual(await loadLaneStaleRuns(null), {});
    assert.deepEqual(await loadLaneCadence(undefined, 0), {});
    assert.deepEqual(
      await loadLaneStaleRuns(fakeDb(new Error("no such table"))),
      {},
    );
    assert.deepEqual(await loadLaneCadence(fakeDb(new Error("boom")), 0), {});
  });
});

describe("laneAlarmGitHub", () => {
  function client(handler: (url: string, init?: RequestInit) => unknown) {
    const seen: { url: string; init?: RequestInit }[] = [];
    const impl = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      const out = handler(url, init);
      return out ?? { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;
    return { seen, gh: laneAlarmGitHub("t0ken", "o/r", impl) };
  }

  test("lists only open lane alarms, keyed by lane", async () => {
    const { gh, seen } = client(() => ({
      ok: true,
      json: async () => [
        { number: 1, title: `${LANE_ALARM_TITLE_PREFIX}neurons-staleness` },
        { number: 2, title: "feat: unrelated" },
        // A PR whose title matches would otherwise be closed as an alarm.
        {
          number: 3,
          title: `${LANE_ALARM_TITLE_PREFIX}metagraph`,
          pull_request: {},
        },
        { number: 4, title: LANE_ALARM_TITLE_PREFIX },
        { number: null, title: `${LANE_ALARM_TITLE_PREFIX}ghost` },
        { title: `${LANE_ALARM_TITLE_PREFIX}nameless` },
        {},
      ],
    }));
    assert.deepEqual(await gh.listOpen(), { "neurons-staleness": 1 });
    assert.match(
      seen[0].url,
      /\/repos\/o\/r\/issues\?state=open&per_page=100$/,
    );
  });

  test("an error or a non-array body lists nothing", async () => {
    const bad = client(() => ({ ok: false, json: async () => [] }));
    assert.deepEqual(await bad.gh.listOpen(), {});
    const odd = client(() => ({
      ok: true,
      json: async () => ({ message: "nope" }),
    }));
    assert.deepEqual(await odd.gh.listOpen(), {});
  });

  test("opens an issue and returns its number", async () => {
    const { gh, seen } = client(() => ({
      ok: true,
      json: async () => ({ number: 99 }),
    }));
    const alarm = {
      lane: "a",
      kind: "stale" as const,
      since: NOW,
      ticks: 1,
      detail: null,
      age_ms: null,
      cadence_ms: null,
    };
    assert.equal(await gh.open(alarm, "t", "b"), 99);
    assert.equal(seen[0].init?.method, "POST");
    assert.deepEqual(JSON.parse(String(seen[0].init?.body)), {
      title: "t",
      body: "b",
    });
  });

  test("a rejected or numberless create reports null rather than a false success", async () => {
    const denied = client(() => ({ ok: false, json: async () => ({}) }));
    const alarm = {
      lane: "a",
      kind: "stale" as const,
      since: NOW,
      ticks: 1,
      detail: null,
      age_ms: null,
      cadence_ms: null,
    };
    assert.equal(await denied.gh.open(alarm, "t", "b"), null);
    const odd = client(() => ({ ok: true, json: async () => ({}) }));
    assert.equal(await odd.gh.open(alarm, "t", "b"), null);
  });

  test("comments before it closes, so the history carries the reason", async () => {
    const { gh, seen } = client(() => ({ ok: true, json: async () => ({}) }));
    assert.equal(await gh.close(12, "recovered"), true);
    assert.match(seen[0].url, /\/issues\/12\/comments$/);
    assert.equal(seen[1].init?.method, "PATCH");
    assert.deepEqual(JSON.parse(String(seen[1].init?.body)), {
      state: "closed",
      state_reason: "completed",
    });
  });

  test("still closes when the comment fails", async () => {
    // The close is the point. A dropped comment is a worse issue history, not
    // an alarm left open forever.
    let first = true;
    const { gh } = client(() => {
      if (first) {
        first = false;
        throw new Error("comment rejected");
      }
      return { ok: true, json: async () => ({}) };
    });
    assert.equal(await gh.close(12, "recovered"), true);
  });

  test("reports a failed close rather than counting it", async () => {
    const { gh } = client((url) =>
      url.endsWith("/comments")
        ? { ok: true, json: async () => ({}) }
        : { ok: false, json: async () => ({}) },
    );
    assert.equal(await gh.close(12, "recovered"), false);
  });
});

describe("runLaneAlarm", () => {
  /** A GitHub double that records what it was asked to do. */
  function fakeGitHub(open: Record<string, number> = {}): LaneAlarmGitHub & {
    opened: string[];
    closed: number[];
  } {
    const opened: string[] = [];
    const closed: number[] = [];
    return {
      opened,
      closed,
      listOpen: async () => open,
      open: async (alarm) => {
        opened.push(alarm.lane);
        return 100 + opened.length;
      },
      close: async (issue) => {
        closed.push(issue);
        return true;
      },
    };
  }

  /** A D1 double answering each of the three reads with its own rows. */
  function healthDb(rows: {
    latest?: Record<string, unknown>[];
    runs?: Record<string, unknown>[];
    cadence?: Record<string, unknown>[];
  }) {
    const written: Record<string, unknown>[] = [];
    return {
      written,
      prepare(sql: string) {
        const answer = async () => {
          if (sql === LANE_STALE_RUN_SQL) return { results: rows.runs ?? [] };
          if (sql === LANE_CADENCE_SQL) return { results: rows.cadence ?? [] };
          return { results: rows.latest ?? [] };
        };
        return {
          bind(...values: unknown[]) {
            return {
              run: async () => {
                if (sql.startsWith("INSERT")) {
                  written.push({ sql, values });
                }
                return {};
              },
              first: async () => null,
              all: answer,
            };
          },
          all: answer,
        };
      },
    };
  }

  const env = { GITHUB_TOKEN: "t", METAGRAPH_HEALTH_DB: null as unknown };

  test("opens an issue for a lane stale past the threshold, and records its own tick", async () => {
    const db = healthDb({
      latest: [
        {
          lane: "neurons-staleness",
          verdict: "stale",
          age_ms: 4 * HOUR,
          detail: "partial",
          checked_at: NOW - 1000,
        },
      ],
      runs: [{ lane: "neurons-staleness", since: NOW - 28 * HOUR, ticks: 112 }],
      cadence: [
        {
          lane: "neurons-staleness",
          n: 100,
          first: NOW - 25 * HOUR,
          last: NOW,
        },
      ],
    });
    const github = fakeGitHub();
    const out = await runLaneAlarm(
      { ...env, METAGRAPH_HEALTH_DB: db },
      { github, now: () => NOW, recordException: async () => true },
    );
    assert.equal(out.ok, true);
    assert.equal(out.alarming, 1);
    assert.equal(out.opened, 1);
    assert.deepEqual(github.opened, ["neurons-staleness"]);
    // The reader's own verdict, so a reader that stops is itself visible.
    assert.equal(db.written.length, 1);
    assert.deepEqual(db.written[0].values, [
      "lane-alarm",
      "ok",
      null,
      "1 alarming, 0 recovered, 1 lanes",
      NOW,
    ]);
  });

  test("closes the issue once the lane reports ok", async () => {
    const db = healthDb({
      latest: [
        {
          lane: "neurons-staleness",
          verdict: "ok",
          age_ms: 60_000,
          detail: null,
          checked_at: NOW - 1000,
        },
      ],
    });
    const github = fakeGitHub({ "neurons-staleness": 4242 });
    const out = await runLaneAlarm(
      { ...env, METAGRAPH_HEALTH_DB: db },
      { github, now: () => NOW, recordException: async () => true },
    );
    assert.equal(out.recovered, 1);
    assert.equal(out.closed, 1);
    assert.deepEqual(github.closed, [4242]);
  });

  test("an unreadable issue list stops the tick rather than duplicating every alarm", async () => {
    // The single most damaging thing this could do: treat a failed list as
    // "nothing is open" and re-open every outstanding alarm, every tick.
    const db = healthDb({
      latest: [
        {
          lane: "a",
          verdict: "stale",
          age_ms: 1,
          detail: null,
          checked_at: NOW,
        },
      ],
      runs: [{ lane: "a", since: NOW - 28 * HOUR, ticks: 100 }],
    });
    const github = fakeGitHub();
    github.listOpen = async () => {
      throw new Error("502 from github");
    };
    const out = await runLaneAlarm(
      { ...env, METAGRAPH_HEALTH_DB: db },
      { github, now: () => NOW },
    );
    assert.deepEqual(out, {
      ok: false,
      reason: "issue_list_unavailable",
      lanes: 1,
    });
    assert.deepEqual(github.opened, []);
  });

  test("still records the alarm when no token is configured", async () => {
    // Notification degrades to PostHog alone; the tick still runs and the
    // durable verdict still lands.
    const db = healthDb({
      latest: [
        {
          lane: "a",
          verdict: "stale",
          age_ms: 1,
          detail: null,
          checked_at: NOW,
        },
      ],
      runs: [{ lane: "a", since: NOW - 28 * HOUR, ticks: 100 }],
    });
    const seen: unknown[] = [];
    const out = await runLaneAlarm(
      { METAGRAPH_HEALTH_DB: db },
      {
        now: () => NOW,
        recordException: async (_env, payload) => {
          seen.push(payload);
          return true;
        },
      },
    );
    assert.equal(out.ok, true);
    assert.equal(out.delivered, false);
    assert.equal(out.opened, 0);
    assert.equal(seen.length, 1);
  });

  test("counts a rejected create as not opened", async () => {
    const db = healthDb({
      latest: [
        {
          lane: "a",
          verdict: "stale",
          age_ms: 1,
          detail: null,
          checked_at: NOW,
        },
      ],
      runs: [{ lane: "a", since: NOW - 28 * HOUR, ticks: 100 }],
    });
    const github = fakeGitHub();
    github.open = async () => {
      throw new Error("rate limited");
    };
    const out = await runLaneAlarm(
      { ...env, METAGRAPH_HEALTH_DB: db },
      { github, now: () => NOW, recordException: async () => true },
    );
    assert.equal(out.alarming, 1);
    assert.equal(out.opened, 0);
  });

  test("counts a rejected close as not closed", async () => {
    const db = healthDb({
      latest: [
        { lane: "a", verdict: "ok", age_ms: 1, detail: null, checked_at: NOW },
      ],
    });
    const github = fakeGitHub({ a: 5 });
    github.close = async () => {
      throw new Error("rate limited");
    };
    const out = await runLaneAlarm(
      { ...env, METAGRAPH_HEALTH_DB: db },
      { github, now: () => NOW, recordException: async () => true },
    );
    assert.equal(out.recovered, 1);
    assert.equal(out.closed, 0);
  });

  test("honours an overridden threshold and repo", async () => {
    const db = healthDb({
      latest: [
        {
          lane: "a",
          verdict: "stale",
          age_ms: 1,
          detail: null,
          checked_at: NOW,
        },
      ],
      runs: [{ lane: "a", since: NOW - 90 * 60_000, ticks: 6 }],
    });
    const calls: string[] = [];
    const out = await runLaneAlarm(
      {
        GITHUB_TOKEN: "t",
        LANE_ALARM_REPO: "o/other",
        LANE_ALARM_MIN_STALE_MS: 2 * HOUR,
        METAGRAPH_HEALTH_DB: db,
      },
      {
        now: () => NOW,
        recordException: async () => true,
        fetchImpl: (async (url: string) => {
          calls.push(String(url));
          return { ok: true, json: async () => [] };
        }) as unknown as typeof fetch,
      },
    );
    // 90 minutes is under the overridden 2-hour threshold.
    assert.equal(out.alarming, 0);
    assert.match(calls[0], /\/repos\/o\/other\/issues/);
  });

  test("builds its own GitHub client from the ambient fetch when given none", async () => {
    // The wiring the cron actually uses: no deps at all beyond the clock.
    const db = healthDb({
      latest: [
        {
          lane: "a",
          verdict: "ok",
          age_ms: 1,
          detail: null,
          checked_at: NOW - 40 * HOUR,
        },
      ],
      cadence: [
        { lane: "a", n: 50, first: NOW - 50 * HOUR, last: NOW - 40 * HOUR },
      ],
    });
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      return {
        ok: true,
        json: async () => (calls.length === 1 ? [] : { number: 7 }),
      };
    }) as unknown as typeof fetch;
    try {
      const out = await runLaneAlarm(
        { ...env, METAGRAPH_HEALTH_DB: db },
        { now: () => NOW, recordException: async () => true },
      );
      // Silent, not stale -- so this also exercises the `lane_silent` code.
      assert.equal(out.alarming, 1);
      assert.equal(out.opened, 1);
    } finally {
      globalThis.fetch = original;
    }
    assert.match(
      calls[0],
      /\/repos\/JSONbored\/metagraphed\/issues\?state=open/,
    );
  });

  test("reports a missing binding rather than throwing", async () => {
    assert.deepEqual(await runLaneAlarm({}), {
      ok: false,
      reason: "d1 binding unavailable",
    });
    assert.deepEqual(await runLaneAlarm(null), {
      ok: false,
      reason: "d1 binding unavailable",
    });
  });

  test("survives a telemetry sink that rejects", async () => {
    const db = healthDb({
      latest: [
        {
          lane: "a",
          verdict: "stale",
          age_ms: 1,
          detail: null,
          checked_at: NOW,
        },
      ],
      runs: [{ lane: "a", since: NOW - 28 * HOUR, ticks: 100 }],
    });
    const out = await runLaneAlarm(
      { METAGRAPH_HEALTH_DB: db },
      {
        now: () => NOW,
        recordException: async () => {
          throw new Error("posthog is down");
        },
      },
    );
    assert.equal(out.ok, true);
    assert.equal(out.alarming, 1);
  });
});

describe("laneAlarmTitle", () => {
  test("is the dedup key, and is stable across ticks", () => {
    assert.equal(
      laneAlarmTitle("neurons-staleness"),
      `${LANE_ALARM_TITLE_PREFIX}neurons-staleness`,
    );
  });
});
