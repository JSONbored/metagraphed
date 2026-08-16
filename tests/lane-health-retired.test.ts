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
import { existsSync, readFileSync } from "node:fs";
import { describe, test } from "vitest";
import { PRODUCER_CADENCE_SECS } from "../src/producer-cadence.ts";
// The string-aware stripper, not a regex: wrangler.jsonc holds `"*/2 * * * *"`
// and `"/api/*"`, which a naive comment regex splices together.
import { stripJsonComments } from "../scripts/lib.ts";
import {
  RETIRED_LANES,
  RETIRED_LANE_PREFIXES,
  isRetiredLane,
  loadLatestLaneHealth,
} from "../src/lane-health.ts";
import { neonLaneKey } from "../src/neon-write.ts";
import {
  DEAD_LETTER_LANE_NAMES,
  isDeadLetterQueue,
} from "../src/dead-letter.ts";
import { RAW_CAPTURE_STATE_NEON_LANE } from "../src/capture-state-neon-write.ts";
import { NEURONS_NEON_LANE } from "../src/neurons-neon-write.ts";
// The lane constant lives with its cron in the data-api Worker.
import { TAO_USD_INDEX_NEON_LANE } from "../workers/data-api.ts";

/** Each retired lane, and the producer whose deletion justifies retiring it.
 * `null` marks the one entry whose producer was a KEY SPELLING rather than a
 * file -- the pre-#10851 buffer flush wrote per-lane verdicts under the bare
 * statement tag -- justified below by a code assertion instead: the live
 * writer provably files under the `neon:` prefix. */
const PRODUCERS: Record<string, string | null> = {
  "neon-parity": "src/neon-parity.ts",
  "neon-mirror-lag": "src/neon-mirror-lag.ts",
  "neon:backfill:": "src/neon-backfill.ts",
  "raw-capture-state": null,
  // Same #10851 key change, two more spellings -- justified by the code
  // assertion below rather than by a deleted file.
  neurons: null,
  "tao-usd-index": null,
  // Its producer was a QUEUE, not a file -- justified by the code assertion
  // below: nothing can write a `*-dlq` lane that DEAD_LETTER_LANES no longer
  // names.
  "revenue-probes-dlq": null,
  // The same #10851 key change again, and the two the 2026-08-12 sweep missed
  // -- justified by the DERIVED assertion below rather than by a deleted file.
  "nominator-positions": null,
  "validator-nominator-counts": null,
};

/**
 * The lanes whose Neon writes go through the write-behind buffer, read from the
 * DEPLOYED configs rather than hand-copied into this file.
 *
 * The UNION across the three Workers, not one of them and not an equality
 * assertion between them. Each Worker sets its own `NEON_WRITE_BUFFER_LANES`
 * and they are free to differ -- but `RETIRED_LANES` is global, so a lane
 * buffered by any one of them is a lane whose bare spelling this rule must
 * classify. Reading a single config would sample the set that the rule below
 * exists to stop anyone sampling.
 */
function bufferedLanes(): string[] {
  const lanes = new Set<string>();
  for (const config of [
    "../wrangler.jsonc",
    "../wrangler.data.jsonc",
    "../wrangler.registry.jsonc",
  ]) {
    const parsed = JSON.parse(
      stripJsonComments(readFileSync(new URL(config, import.meta.url), "utf8")),
    ) as { vars?: { NEON_WRITE_BUFFER_LANES?: string } };
    for (const lane of (parsed.vars?.NEON_WRITE_BUFFER_LANES ?? "").split(
      ",",
    )) {
      if (lane.trim()) lanes.add(lane.trim());
    }
  }
  return [...lanes].sort();
}

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
      assert.ok(
        name in PRODUCERS,
        `${name} names the producer it retires (or null with a code assertion)`,
      );
      const producer = PRODUCERS[name];
      if (producer === null) continue; // justified by its own test below
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

  test("a dead-letter lane whose QUEUE was deleted cannot be written", () => {
    // #11254 collapsed four probe dead letters into one `probe-jobs-dlq` and
    // deleted `revenue-probes` from the account. `handleDeadLetterBatch` is the
    // ONLY writer for a `*-dlq` lane and it keys off DEAD_LETTER_LANES, so a
    // queue no longer in that map can produce no verdict at all -- which is
    // this list's criterion, reached through code rather than a deleted file.
    assert.equal(isDeadLetterQueue("revenue-probes-dlq"), false);
    assert.equal(DEAD_LETTER_LANE_NAMES.has("revenue-probes-dlq"), false);
    assert.equal(isRetiredLane("revenue-probes-dlq"), true);
    // ...and the lane that REPLACED it stays watched. Retiring the survivor
    // would be suppression rather than cleanup, and it has a live writer.
    assert.equal(isDeadLetterQueue("probe-jobs-dlq"), true);
    assert.equal(isRetiredLane("probe-jobs-dlq"), false);
  });

  test("a buffered lane's bare spelling is retired EXACTLY when no producer writes it", () => {
    // THE RULE THE LIST ABOVE WAS MISSING, and the reason #11268/#11269 were
    // filed three days after the fossils they name were created.
    //
    // #10851 moved the buffer flush onto `neonLaneKey`, so every buffered
    // lane's verdict now lands under `neon:<lane>`. For a bare spelling that
    // leaves exactly one possible writer: the POLLER, which reports its own
    // scan outcome ("120221 scanned, 130194 written, 0 error(s)") under its
    // lane name. Poller lane names ARE the producer names -- that is what
    // PRODUCER_CADENCE_SECS is keyed by, stated in its own doc comment -- so a
    // buffered lane whose bare name is not a producer has no writer at all.
    //
    // NOT CIRCULAR, and this is the part that matters. PRODUCER_CADENCE_SECS is
    // maintained for a different purpose (silence floors) and cross-checked
    // against each `*-staleness-watchdog.ts` threshold in
    // tests/lane-silence-cadence.test.ts, so it is an independent artifact
    // rather than a restatement of this list. The classification was then
    // MEASURED: on 2026-08-15 production `lane_health` held exactly five bare
    // lanes frozen at the #10851 deploy -- raw-capture-state, neurons,
    // tao-usd-index, nominator-positions, validator-nominator-counts -- and
    // exactly the other five buffered lanes were live that hour. Ten of ten.
    //
    // Derived rather than listed, because the list is what failed: the three
    // retired on 2026-08-12 were the ones ALARMING that day, and the two daily
    // lanes had not yet crossed a 24h bound. Any future key change is caught
    // here on the commit that makes it, not on whatever schedule the slowest
    // affected producer happens to run at.
    const fossils: string[] = [];
    const live: string[] = [];
    for (const lane of bufferedLanes()) {
      const hasProducer = lane.replaceAll("-", "_") in PRODUCER_CADENCE_SECS;
      (hasProducer ? live : fossils).push(lane);
      assert.equal(
        isRetiredLane(lane),
        !hasProducer,
        hasProducer
          ? `${lane} is written by the poller under its bare name -- retiring it would be suppression`
          : `${lane} is buffered and has no producer of its own name, so since #10851 nothing writes the bare spelling: retire it in RETIRED_LANES`,
      );
      // The prefixed spelling is the live one in BOTH cases and is never
      // retired -- retiring it would mute the flush itself.
      assert.equal(
        isRetiredLane(neonLaneKey(lane)),
        false,
        `${neonLaneKey(lane)} stays watched`,
      );
    }
    // Non-vacuity, on both sides. An empty `fossils` would pass the loop while
    // proving nothing, and an empty `live` would mean the producer table had
    // been emptied rather than that the rule holds.
    //
    // `raw-capture-state` was in this list until it left the buffered set
    // entirely: it is in NEVER_BUFFER_LANES now, because its producer reads
    // the row back to decide where to resume. It is still a fossil and still
    // retired -- an unbuffered lane records under `neon:<lane>` too, so the
    // bare spelling has no writer either way -- and that is asserted directly
    // in "the three lanes #10851 orphaned" above. What changed is only that
    // this DERIVED sweep no longer reaches it, because the sweep is over
    // buffered lanes.
    assert.deepEqual(fossils, [
      "neurons",
      "nominator-positions",
      "tao-usd-index",
      "validator-nominator-counts",
    ]);
    assert.deepEqual(live, [
      "account-balances",
      "account-identity",
      "hotkey-alpha",
      "subnet-hyperparams",
      "subnet-identity",
    ]);
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
