import assert from "node:assert/strict";
import { test } from "vitest";
import {
  evaluateFreshness,
  formatDuration,
} from "../scripts/check-publish-freshness.ts";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-07-26T12:00:00.000Z");
const MAX_AGE = 48 * HOUR;

function at(hoursAgo: number): string {
  return new Date(NOW - hoursAgo * HOUR).toISOString();
}

test("a recent publish is fresh", () => {
  const verdict = evaluateFreshness({
    publishedAt: at(1),
    now: NOW,
    maxAgeMs: MAX_AGE,
  });
  assert.equal(verdict.status, "fresh");
});

test("the four-day gap this alarm exists for is stale", () => {
  // The real incident: last publish 2026-07-22, discovered 2026-07-26.
  const verdict = evaluateFreshness({
    publishedAt: "2026-07-22T18:15:00.789Z",
    now: NOW,
    maxAgeMs: MAX_AGE,
  });
  assert.equal(verdict.status, "stale");
  assert.ok(verdict.status === "stale" && verdict.ageMs > 3 * 24 * HOUR);
});

test("age exactly at the threshold is fresh, one millisecond past is stale", () => {
  // A publish landing right on the limit is on time, not late.
  assert.equal(
    evaluateFreshness({
      publishedAt: new Date(NOW - MAX_AGE).toISOString(),
      now: NOW,
      maxAgeMs: MAX_AGE,
    }).status,
    "fresh",
  );
  assert.equal(
    evaluateFreshness({
      publishedAt: new Date(NOW - MAX_AGE - 1).toISOString(),
      now: NOW,
      maxAgeMs: MAX_AGE,
    }).status,
    "stale",
  );
});

test("a missing or unparseable timestamp is unknown, never silently fresh", () => {
  for (const value of [undefined, null, "", "   ", "not-a-date", 12345]) {
    const verdict = evaluateFreshness({
      publishedAt: value,
      now: NOW,
      maxAgeMs: MAX_AGE,
    });
    assert.equal(
      verdict.status,
      "unknown",
      `expected unknown for ${JSON.stringify(value)}`,
    );
  }
});

test("a future timestamp is reported, not treated as maximally fresh", () => {
  // A clock or pipeline fault would otherwise look like the healthiest
  // possible state — the one case where "newest" is a red flag.
  const verdict = evaluateFreshness({
    publishedAt: new Date(NOW + 6 * HOUR).toISOString(),
    now: NOW,
    maxAgeMs: MAX_AGE,
  });
  assert.equal(verdict.status, "unknown");
  assert.match(verdict.status === "unknown" ? verdict.reason : "", /future/);
});

test("small clock skew is tolerated rather than flagged", () => {
  // Seconds of skew between the runner and the publisher are normal.
  const verdict = evaluateFreshness({
    publishedAt: new Date(NOW + 5_000).toISOString(),
    now: NOW,
    maxAgeMs: MAX_AGE,
  });
  assert.equal(verdict.status, "fresh");
});

test("durations read the way a human would say them", () => {
  assert.equal(formatDuration(0), "0m");
  assert.equal(formatDuration(45 * 60_000), "45m");
  assert.equal(formatDuration(3 * HOUR), "3h");
  assert.equal(formatDuration(26 * HOUR), "1d 2h");
  assert.equal(formatDuration(4 * 24 * HOUR), "4d");
});
