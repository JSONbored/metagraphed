// A deleted lane's last verdict was served forever (#10222).
//
// THE BUG. `loadLatestLaneHealth` takes the newest row per lane with no liveness
// bound. That is correct while a producer exists -- the newest thing it said IS the
// current truth. It inverts the moment the producer is deleted, because no future
// tick can revise the row. #10167 removed the reconciler, the parity sweep and the
// mirror-lag watchdog; `neon-parity` went on reporting `stale` with deficits measured
// against a D1 that was itself deleted the next day, so `stale_lane_count` could
// never return to zero on `/api/v1/self-health` or `get_self_health`.
//
// WHY THE LIST IS TIED TO FILES. A hand-maintained "ignore these" list is exactly the
// shape that rots into suppression: someone adds a noisy lane, the producer keeps
// running, and the alarm is gone. Pinning each entry to a file that must NOT exist
// makes the claim checkable -- a lane can only be retired if the thing that wrote it
// is genuinely gone, and resurrecting a producer fails here until its name is removed.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, test } from "vitest";
import {
  RETIRED_LANES,
  RETIRED_LANE_PREFIXES,
  isRetiredLane,
  loadLatestLaneHealth,
} from "../src/lane-health.ts";
import { neonLaneKey } from "../src/neon-write.ts";
import { RAW_CAPTURE_STATE_NEON_LANE } from "../src/capture-state-neon-write.ts";
import { NEURONS_NEON_LANE } from "../src/neurons-neon-write.ts";
// The lane constant lives with its cron in the data-api Worker.
import { TAO_USD_INDEX_NEON_LANE } from "../workers/data-api.ts";

/** Each retired lane, and the producer whose deletion justifies retiring it. */
const PRODUCERS: Record<string, string> = {
  "neon-parity": "src/neon-parity.ts",
  "neon-mirror-lag": "src/neon-mirror-lag.ts",
  "neon:backfill:": "src/neon-backfill.ts",
  "raw-capture-state": null,
  // Same #10851 key change, two more spellings -- justified by the code
  // assertion below rather than by a deleted file.
  neurons: null,
  "tao-usd-index": null,
};

function fakeDb(rows: Record<string, unknown>[]) {
  return {
    query: async () => rows,
    run: async () => ({ changes: 1 }),
  };
}

const row = (lane: string, verdict = "stale", checked_at = 1) => ({
  lane,
  verdict,
  age_ms: 1,
  detail: "d",
  checked_at,
});

describe("retired lanes (#10222)", () => {
  test("every retired name is justified by a producer that no longer exists", () => {
    const names = [...RETIRED_LANES, ...RETIRED_LANE_PREFIXES];
    assert.ok(names.length > 0, "the list is not empty -- otherwise vacuous");
    for (const name of names) {
      const producer = PRODUCERS[name];
      assert.ok(producer, `${name} names the producer it retires`);
      assert.equal(
        existsSync(new URL(`../${producer}`, import.meta.url)),
        false,
        `${producer} is gone -- ${name} may only be retired because nothing writes it`,
      );
    }
  });

  test("the bare #10851 spellings cannot be written by the live writer", () => {
    // Every one of these lanes still runs -- what changed in #10851 is the KEY
    // its verdicts land under. Retiring the bare spelling silences a row
    // frozen at that deploy; the prefixed lane stays watched, and was `ok` on
    // the same production read that showed these three stuck.
    for (const lane of [
      RAW_CAPTURE_STATE_NEON_LANE,
      NEURONS_NEON_LANE,
      TAO_USD_INDEX_NEON_LANE,
    ]) {
      assert.equal(isRetiredLane(lane), true, `${lane} (bare) is retired`);
      assert.equal(
        isRetiredLane(neonLaneKey(lane)),
        false,
        `${neonLaneKey(lane)} stays watched`,
      );
    }
  });

  test("the POLLER's own bare lanes are NOT retired", () => {
    // The distinction this list turns on. `account-balances` and
    // `validator-nominators` carry the poller's own scan outcome under their
    // bare names ("558009 scanned, 366107 written"), so those spellings have a
    // live writer and retiring them would be suppression, not cleanup.
    assert.equal(isRetiredLane("account-balances"), false);
    assert.equal(isRetiredLane("validator-nominators"), false);
  });

  test("raw-capture-state (bare) cannot be written by the live writer", () => {
    // The bare spelling's producer was the pre-#10851 flush; since #10851
    // both writers key through neonLaneKey, so every verdict for this lane
    // lands under the prefix. Retiring the bare key silences a row frozen at
    // that deploy — not a live signal. The prefixed lane stays watched.
    assert.equal(
      neonLaneKey(RAW_CAPTURE_STATE_NEON_LANE),
      "neon:raw-capture-state",
    );
    assert.equal(isRetiredLane(RAW_CAPTURE_STATE_NEON_LANE), true);
    assert.equal(isRetiredLane("neon:raw-capture-state"), false);
  });

  test("isRetiredLane matches the families and nothing else", () => {
    assert.equal(isRetiredLane("neon-parity"), true);
    assert.equal(isRetiredLane("neon-mirror-lag"), true);
    assert.equal(isRetiredLane("neon:backfill:tao_usd_index"), true);
    assert.equal(isRetiredLane("neon:backfill:surface_checks"), true);
    // The live `neon:<lane>` mirrors share a prefix with the retired backfills and
    // must NOT be caught: src/neon-write.ts builds them as `neon:${lane}`, and they
    // are the only writers left for those tables.
    assert.equal(isRetiredLane("neon:hotkey-alpha"), false);
    assert.equal(isRetiredLane("neon:neurons-prune"), false);
    assert.equal(isRetiredLane("neon:backfill"), false);
    assert.equal(isRetiredLane("neon-parity-2"), false);
    assert.equal(isRetiredLane("table-freshness"), false);
  });

  test("the serving read drops retired lanes and keeps live ones", async () => {
    const lanes = await loadLatestLaneHealth(
      fakeDb([
        row("neon-parity"),
        row("neon-mirror-lag", "ok"),
        row("neon:backfill:tao_usd_index"),
        row("neon:hotkey-alpha"),
        row("table-freshness", "ok"),
      ]) as unknown as Parameters<typeof loadLatestLaneHealth>[0],
    );
    assert.deepEqual(Object.keys(lanes).sort(), [
      "neon:hotkey-alpha",
      "table-freshness",
    ]);
    // Not a blanket mute: a live lane's `stale` still arrives, which is what makes
    // dropping the retired ones something other than suppression.
    assert.equal(lanes["neon:hotkey-alpha"]?.verdict, "stale");
  });

  test("a retired lane cannot make stale_lane_count non-zero on its own", async () => {
    const lanes = await loadLatestLaneHealth(
      fakeDb([
        row("neon-parity"),
        row("neon:backfill:surface_checks"),
      ]) as unknown as Parameters<typeof loadLatestLaneHealth>[0],
    );
    assert.deepEqual(lanes, {});
  });
});
