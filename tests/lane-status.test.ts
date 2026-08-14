// The lane-status rule, tested without a bucket (JSONbored/metagraphed-infra#571).
//
// The claim worth pinning hardest is the KILLED case: `checked_at` is written
// only on completion and the mid-scan heartbeat overwrites the whole object, so
// a SIGKILLed pass leaves an ABSENT timestamp rather than an old one. Reading
// that as "nothing to say" is precisely how the account-summary outage stayed
// quiet for five and a half hours while the route it protects silently went
// back to scanning 4,374 MB per request.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  EXPECTED_LANES,
  KNOWN_STALE,
  evaluate,
  laneNamesFrom,
  PREFIX,
} from "../scripts/check-lane-status.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-08-14T21:00:00Z");

function at(offsetMs: number): string {
  return new Date(NOW - offsetMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

const COMPLETED = "account-events-rollup-status.json";
const DECODE = "decode-run-status.json";
const SUMMARY = "account-summary-status.json";

describe("lane status", () => {
  test("an UNCLASSIFIED lane fails -- absent is not exempt", () => {
    // The rule the lakehouse and Neon watchdogs already hold: absent means
    // nobody thought about it, and a lane nobody classified is watched by
    // nothing, forever. This is the one that catches a lane added in the
    // PRIVATE repo, which is where every one of these producers lives.
    const v = evaluate(
      { lane: "brand-new-status.json", body: {}, nowMs: NOW },
      undefined,
    );
    assert.equal(v.ok, false);
    assert.match(v.detail, /not classified/);
  });

  test("a completed pass inside its bound passes", () => {
    const v = evaluate(
      {
        lane: COMPLETED,
        body: { ok: true, checked_at: at(40 * 60 * 1000) },
        nowMs: NOW,
      },
      EXPECTED_LANES[COMPLETED],
    );
    assert.equal(v.ok, true);
  });

  test("a lane past its bound is STALE, and says by how much", () => {
    const v = evaluate(
      {
        lane: COMPLETED,
        body: { ok: true, checked_at: at(9 * HOUR) },
        nowMs: NOW,
      },
      EXPECTED_LANES[COMPLETED],
    );
    assert.equal(v.ok, false);
    assert.match(v.detail, /9\.0h/);
    assert.match(v.detail, /over its 6\.0h bound/);
  });

  test("a KILLED pass is reported as started-and-never-completed", () => {
    // THE CASE THIS WHOLE CHECK EXISTS FOR, and the exact body production was
    // serving at 2026-08-14 21:00Z.
    const v = evaluate(
      {
        lane: SUMMARY,
        body: {
          phase: "scanning",
          started_at: at(35 * 60 * 1000),
          ok: null,
          window: "19/21",
          rows_scanned: 246239473,
        },
        nowMs: NOW,
      },
      EXPECTED_LANES[SUMMARY],
    );
    assert.equal(v.ok, false);
    assert.match(v.detail, /STARTED .* and never completed/);
    // The phase and window travel with it, or the alert sends the reader back
    // to inference -- which is what the mid-scan heartbeat was added to stop.
    assert.match(v.detail, /phase="scanning"/);
    assert.match(v.detail, /window 19\/21/);
  });

  test("a killed pass fails even when it died SECONDS ago", () => {
    // Staleness cannot catch this: the object is fresh, it is the COMPLETION
    // that is missing. A bound-only check would call a lane that dies on every
    // pass perfectly healthy, forever.
    const v = evaluate(
      {
        lane: SUMMARY,
        body: { phase: "scanning", started_at: at(5_000), ok: null },
        nowMs: NOW,
      },
      EXPECTED_LANES[SUMMARY],
    );
    assert.equal(v.ok, false);
  });

  test("ok:false is reported as a failed pass, not a stale one", () => {
    // A lane that ran on time and FAILED is a different fault from one that
    // stopped running. Reporting the fresh timestamp first would describe a
    // broken lane as healthy.
    const v = evaluate(
      {
        lane: COMPLETED,
        body: {
          ok: false,
          checked_at: at(60_000),
          failures: { _lane: "RuntimeError: boom" },
        },
        nowMs: NOW,
      },
      EXPECTED_LANES[COMPLETED],
    );
    assert.equal(v.ok, false);
    assert.match(v.detail, /ok:false/);
    assert.match(v.detail, /RuntimeError: boom/);
  });

  test("ok:null does not read as ok:false", () => {
    // The heartbeat writes `ok: null` mid-scan. A truthiness test would call
    // that a recorded failure and report the wrong fault for every killed run.
    const v = evaluate(
      { lane: SUMMARY, body: { ok: null, checked_at: at(60_000) }, nowMs: NOW },
      EXPECTED_LANES[SUMMARY],
    );
    assert.equal(v.ok, true);
  });

  test("the decoder's OWN shape is read, not the python one", () => {
    // Two shapes exist: `{checked_at, ok}` and `{updated_at, status}`. Reading
    // one out of the other yields undefined, which would evaluate as "no
    // completion recorded" and make every decode run look dead.
    const v = evaluate(
      {
        lane: DECODE,
        body: { status: "ok", updated_at: at(40 * 60 * 1000) },
        nowMs: NOW,
      },
      EXPECTED_LANES[DECODE],
    );
    assert.equal(v.ok, true);
  });

  test("a decoder status other than ok fails", () => {
    const v = evaluate(
      {
        lane: DECODE,
        body: { status: "degraded", updated_at: at(60_000) },
        nowMs: NOW,
      },
      EXPECTED_LANES[DECODE],
    );
    assert.equal(v.ok, false);
    assert.match(v.detail, /status="degraded"/);
  });

  test("an unreadable object is a failure, not a pass", () => {
    // R2 briefly unreachable must not read as "the lane is fine". The whole
    // family of faults here is silent, so the default has to be loud.
    const v = evaluate(
      { lane: COMPLETED, body: null, nowMs: NOW },
      EXPECTED_LANES[COMPLETED],
    );
    assert.equal(v.ok, false);
    assert.match(v.detail, /could not be read/);
  });

  test("an unparseable timestamp fails rather than reading as epoch", () => {
    for (const stamp of ["", "not a date", 1_760_000_000_000]) {
      const v = evaluate(
        { lane: COMPLETED, body: { ok: true, checked_at: stamp }, nowMs: NOW },
        EXPECTED_LANES[COMPLETED],
      );
      assert.equal(v.ok, false, JSON.stringify(stamp));
    }
  });

  test("account-summary fires BEFORE the reader stops trusting the projection", () => {
    // The bound is chosen against the READER, not the producer alone.
    // ACCOUNT_SUMMARY_MAX_AGE_MS is three days; past it /api/v1/accounts/{ss58}
    // silently pays the 4,374 MB scan again. A bound at or past three days
    // would alert only after the surface it protects had already regressed.
    const bound = EXPECTED_LANES[SUMMARY]?.maxAgeMs;
    assert.ok(bound !== null && bound !== undefined);
    assert.ok(
      bound < 3 * DAY,
      `${bound} must fire inside the reader's 3d trust bound`,
    );
  });

  test("every hourly lane is bounded in MISSED TICKS, not one interval", () => {
    // A bound near one producer interval alerts on a lane that is merely
    // working, and a watchdog people learn to ignore is worse than none.
    for (const [lane, rule] of Object.entries(EXPECTED_LANES)) {
      if (rule.maxAgeMs === null) continue;
      assert.ok(rule.maxAgeMs >= 2 * HOUR, `${lane} is bounded too tightly`);
      assert.ok(rule.reason.length > 0, `${lane} has no reason`);
    }
  });

  test("the baseline names only lanes that are actually classified", () => {
    // A baseline entry for a lane no rule covers would silence a lane the
    // sweep never evaluates -- the quietest possible way to lose one.
    const unclassified = Object.keys(KNOWN_STALE).filter(
      (l) => !(l in EXPECTED_LANES),
    );
    assert.deepEqual(unclassified, []);
  });

  test("every baseline entry says WHY, with something to follow", () => {
    for (const [lane, reason] of Object.entries(KNOWN_STALE)) {
      assert.match(reason, /#\d+/, `${lane} must cite the issue tracking it`);
    }
  });
});

describe("which objects are swept", () => {
  test("only *-status.json, so watermarks and gaps are not swept", () => {
    // decode-watermark.json and decode-gaps.json are lane STATE, not a verdict.
    // Sweeping them would demand a freshness rule for something that has no
    // completion semantics at all.
    const lanes = laneNamesFrom([
      `${PREFIX}account-summary-status.json`,
      `${PREFIX}decode-watermark.json`,
      `${PREFIX}decode-gaps.json`,
      `${PREFIX}decode-run-status.json`,
    ]);
    assert.deepEqual(lanes, [
      "account-summary-status.json",
      "decode-run-status.json",
    ]);
  });

  test("the testnet subtree is swept too", () => {
    // Testnet is a SERVED network -- check-lakehouse-freshness had to widen to
    // chain_testnet for the same reason. A nested key must survive as a nested
    // lane name, or it silently stops matching its rule.
    const lanes = laneNamesFrom([`${PREFIX}testnet/decode-run-status.json`]);
    assert.deepEqual(lanes, ["testnet/decode-run-status.json"]);
    assert.ok("testnet/decode-run-status.json" in EXPECTED_LANES);
  });

  test("keys outside the prefix are ignored", () => {
    assert.deepEqual(
      laneNamesFrom(["metagraph/projections/x-status.json"]),
      [],
    );
  });

  test("all seven production lanes are classified", () => {
    // The set observed in the bucket on 2026-08-14. A producer added without a
    // rule fails the sweep at runtime; this fails it at review time.
    for (const lane of [
      "account-events-rollup-status.json",
      "account-summary-status.json",
      "daily-rollup-status.json",
      "decode-run-status.json",
      "rpc-usage-export-status.json",
      "state-mirror-status.json",
      "testnet/decode-run-status.json",
    ]) {
      assert.ok(lane in EXPECTED_LANES, `${lane} is not classified`);
    }
  });
});
