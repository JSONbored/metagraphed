import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildSelfHealth,
  selfHealthProbeMaxAgeMs,
  withCurrentComponentHealth,
} from "../src/self-health.ts";
import { cronIntervalSecs } from "../src/producer-cadence.ts";
import { laneSilenceThresholdMs } from "../src/lane-alarm.ts";
import { SELF_HEALTH_PROBE_CRON } from "../workers/config.ts";

const now = Date.parse("2026-10-19T23:23:00Z");
const maxAge = laneSilenceThresholdMs(
  cronIntervalSecs(SELF_HEALTH_PROBE_CRON)! * 1000,
);
function card(component = "api", ok = true, checkedAt = now) {
  return buildSelfHealth(
    [{ component, day: "2026-10-19", checks: 3, ok_count: 2 }],
    [{
      component,
      ok,
      checked_at_ms: checkedAt,
      http_status: ok ? 200 : 503,
      latency_ms: 42,
    }],
  );
}

test("component freshness uses the actual prober cron and existing silence policy", () => {
  assert.equal(cronIntervalSecs(SELF_HEALTH_PROBE_CRON), 300);
  assert.equal(selfHealthProbeMaxAgeMs(), maxAge);
  assert.equal(selfHealthProbeMaxAgeMs("17 */3 * * *"), laneSilenceThresholdMs(10800000));
  assert.equal(selfHealthProbeMaxAgeMs("not a measurable cron"), null);
});

test("current component evidence preserves success, failure and the exact freshness boundary", () => {
  for (const ok of [true, false]) {
    for (const age of [0, maxAge]) {
      const input = card("api", ok, now - age);
      assert.deepEqual(withCurrentComponentHealth(input, now), input);
    }
  }
  const input = card("api", true, Date.now());
  assert.deepEqual(withCurrentComponentHealth(input), input);
});

test("stale component observations become unknown without changing their history", () => {
  for (const ok of [true, false]) {
    const input = card("api", ok, now - maxAge - 1);
    const output = withCurrentComponentHealth(input, now);
    const before = input.components[0];
    const after = output.components[0];
    assert.equal(after.current_ok, null);
    assert.equal(after.checked_at, before.checked_at);
    assert.equal(after.http_status, before.http_status);
    assert.equal(after.latency_ms, before.latency_ms);
    assert.deepEqual(after.days, before.days);
    assert.equal(after.uptime_90d, before.uptime_90d);
    assert.equal(output.observed_at, input.observed_at);
    assert.match(after.note!, /No current probe reading/);
    assert.equal(output.verdict, "degraded");
    assert.equal(output.measured_component_count, 0);
    assert.equal(input.components[0].current_ok, ok);
  }
});

test("future, invalid and absent component clocks cannot establish current health", () => {
  for (const timestamp of [new Date(now + 1).toISOString(), "invalid", null]) {
    const input = card();
    input.components[0].checked_at = timestamp;
    const output = withCurrentComponentHealth(input, now);
    assert.equal(output.components[0].current_ok, null);
    assert.equal(output.components[0].checked_at, timestamp);
    assert.equal(output.verdict, "degraded");
  }
  assert.equal(withCurrentComponentHealth(card(), now, null).verdict, "degraded");
  const empty = buildSelfHealth([], []);
  assert.deepEqual(withCurrentComponentHealth(empty, now), empty);
});

test("component freshness leaves ingest lane status and publish-only verdict semantics intact", () => {
  const input = card();
  input.lanes = [{ lane: "chain-detail", verdict: "stale", age_ms: 1, detail: "stalled", checked_at: new Date(now).toISOString() }];
  input.stale_lane_count = 1;
  const output = withCurrentComponentHealth(input, now);
  assert.equal(output.verdict, "operational");
  assert.deepEqual(output.lanes, input.lanes);
  assert.equal(output.stale_lane_count, 1);
  const publishOnlyFailure = buildSelfHealth([], [
    { component: "api", ok: true, checked_at_ms: now, http_status: 200, latency_ms: 1 },
    { component: "publish", ok: false, checked_at_ms: now, http_status: 503, latency_ms: 1 },
  ]);
  assert.equal(withCurrentComponentHealth(publishOnlyFailure, now).verdict, "operational");
});
