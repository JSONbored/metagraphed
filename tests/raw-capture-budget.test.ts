import assert from "node:assert/strict";
import { test } from "vitest";
import { RAW_CAPTURE_CRON } from "../workers/config.ts";
import {
  RAW_CAPTURE_LANES,
  MAX_CAPTURE_CHUNK_BLOCKS,
  RPC_REQUESTS_PER_MINUTE_LIMIT,
  pacedLaneBudget,
  cronStepMinutes,
} from "../src/raw-capture-sync.ts";
import {
  CANONICAL_REQUESTS_PER_CHUNK,
  CANONICAL_MAX_RPC_REQUESTS,
} from "../src/raw-chain-capture.ts";
test("every declared lane has a distinct network, endpoint and floor", () => {
  // Cheap, but it is the assertion that would have caught a copy-paste lane
  // pointing at mainnet's endpoint under a testnet label — which writes one
  // chain's blocks under the other's key with no error anywhere.
  const networks = RAW_CAPTURE_LANES.map((lane) => lane.network);
  assert.equal(new Set(networks).size, networks.length);
  const urls = RAW_CAPTURE_LANES.map((lane) => lane.defaultRpcUrl);
  assert.equal(new Set(urls).size, urls.length);
  const floors = RAW_CAPTURE_LANES.map((lane) => lane.genesisFloor);
  assert.equal(new Set(floors).size, floors.length);
  // The combined per-tick budget must stay inside the platform's
  // 1000-subrequest ceiling. COUNTED IN REQUESTS, NOT CALLS: a chunk costs
  // CANONICAL_REQUESTS_PER_CHUNK however many blocks it carries, plus three anchor requests
  // per lane. Counting calls here is what made this read 1,602 against a
  // ceiling of 1,000 for a tick that actually issues 66.
  const subrequests = RAW_CAPTURE_LANES.reduce(
    (total, lane) =>
      total +
      Math.ceil(lane.maxPerTick / MAX_CAPTURE_CHUNK_BLOCKS) *
        CANONICAL_REQUESTS_PER_CHUNK +
      3,
    0,
  );
  assert.ok(
    subrequests < 1000,
    `a tick would issue ${subrequests} subrequests, over the Worker ceiling`,
  );
});

// This used to assert that a whole TICK fit inside one minute's allowance,
// and that premise is exactly what capped testnet at 32 blocks (#9430). An
// UNPACED tick fires its burst at network speed, so one minute bounds it
// however long the tick is. A paced one spends the tick, so the tick bounds
// it -- and what has to fit the limit is the RATE.
test("the paced rate across all lanes stays inside the measured limit", () => {
  // MEASURED IN REQUESTS, because that is what the endpoint counts: one call
  // per request 429'd after 103, while fifty calls per request carried 1,400
  // through 140 requests untouched (2026-08-16). A gap between CHUNKS times
  // the requests a chunk costs is the lane's real rate.
  for (const lane of RAW_CAPTURE_LANES) {
    assert.ok(lane.minGapMs > 0, `${lane.network} is not paced at all`);
    const requestsPerMinute =
      (60_000 / lane.minGapMs) *
      CANONICAL_REQUESTS_PER_CHUNK *
      RAW_CAPTURE_LANES.length;
    assert.ok(
      requestsPerMinute < RPC_REQUESTS_PER_MINUTE_LIMIT,
      `${lane.network} sustains ${requestsPerMinute.toFixed(0)} requests/min across ${RAW_CAPTURE_LANES.length} lanes, at or over ${RPC_REQUESTS_PER_MINUTE_LIMIT}/min`,
    );
  }
});

test("a paced tick finishes inside its own interval", () => {
  // Lanes run CONCURRENTLY, so the wall time is one lane's, not the sum --
  // but it still has to leave slack for jitter and a mid-tick redeploy.
  //
  // The gap is between CHUNK STARTS, so the span is the chunk COUNT times
  // the gap. Multiplying by the block count instead reads 20 minutes for a
  // tick that spends 45 seconds -- and would push the lane back to reading
  // one block at a time to satisfy it.
  const intervalMs = cronStepMinutes(RAW_CAPTURE_CRON) * 60_000;
  for (const lane of RAW_CAPTURE_LANES) {
    const chunks = Math.ceil(lane.maxPerTick / MAX_CAPTURE_CHUNK_BLOCKS);
    const spendMs = chunks * lane.minGapMs;
    assert.ok(
      spendMs < intervalMs,
      `${lane.network} would spend ${(spendMs / 60_000).toFixed(1)} min of a ${intervalMs / 60_000} min tick`,
    );
  }
});

// The paired positive: a budget test that only says "not too fast" is
// satisfied by a lane that never catches up.
test("the budget lets every lane outpace the chain it follows", () => {
  const ticksPerHour = 60 / cronStepMinutes(RAW_CAPTURE_CRON);
  for (const lane of RAW_CAPTURE_LANES) {
    const perHour = lane.maxPerTick * ticksPerHour;
    // Bittensor produces a block every 12 s on both chains.
    assert.ok(
      perHour > 3600 / 12,
      `${lane.network} captures ${perHour}/h against a chain producing 300/h -- it can never catch up`,
    );
  }
});

test("a third network would narrow the shared allowance", () => {
  const two = pacedLaneBudget(2, cronStepMinutes(RAW_CAPTURE_CRON));
  const three = pacedLaneBudget(3, cronStepMinutes(RAW_CAPTURE_CRON));
  assert.ok(three.maxBlocks < two.maxBlocks);
  assert.ok(three.minGapMs > two.minGapMs);
});

test("an unreadable cron narrows the budget rather than widening it", () => {
  assert.equal(cronStepMinutes("11,41 * * * *"), 5);
  assert.equal(cronStepMinutes(""), 5);
  assert.equal(cronStepMinutes("*/2 * * * *"), 2);
});

test("failover RPC attempts share the same per-lane invocation ceiling", () => {
  assert.ok(CANONICAL_MAX_RPC_REQUESTS * RAW_CAPTURE_LANES.length < 1000);
});
