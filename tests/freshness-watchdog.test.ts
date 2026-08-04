// Unit tests for the freshness watchdog (src/freshness-watchdog.ts) and its
// cron wiring (workers/api.ts's runFreshnessWatchdog).
//
// The watchdog's whole value is that it stays quiet until something is actually
// wrong and then says so exactly once, so the reporting DECISION gets as much
// coverage here as the staleness arithmetic -- an alarm that cries every hour is
// the failure mode this is designed against, and it is a behaviour, not a detail.
import assert from "node:assert/strict";
import { test } from "vitest";
import { evaluateFreshness, shouldReport } from "../src/freshness-watchdog.ts";
import { runFreshnessWatchdog } from "../workers/api.ts";

const NOW = Date.parse("2026-08-02T00:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

function source(over: Record<string, unknown> = {}) {
  return {
    id: "adapter:example",
    lane: "adapter-snapshot",
    timestamp: hoursAgo(1),
    stale_after_hours: 12,
    stale_behavior: "warn",
    required_for_publish: false,
    ...over,
  };
}

test("a source inside its own declared limit is not stale", () => {
  const v = evaluateFreshness([source({ timestamp: hoursAgo(11.9) })], NOW);
  assert.deepEqual(v.stale, []);
  assert.equal(v.checked, 1);
  assert.equal(v.signature, "");
});

test("a source past its own declared limit is stale, with its age", () => {
  const v = evaluateFreshness([source({ timestamp: hoursAgo(17.5) })], NOW);
  assert.equal(v.stale.length, 1);
  assert.equal(v.stale[0].id, "adapter:example");
  assert.equal(v.stale[0].ageHours, 17.5);
  assert.equal(v.stale[0].limitHours, 12);
});

// Exactly at the limit is NOT stale -- the policy reads "stale AFTER n hours".
test("a source exactly at its limit is not yet stale", () => {
  const v = evaluateFreshness([source({ timestamp: hoursAgo(12) })], NOW);
  assert.deepEqual(v.stale, []);
});

// "Declares no policy" and "has gone quiet" are different statements; conflating
// them would bury real stalls under permanent noise.
test("sources without a usable stamp or limit are skipped, not reported stale", () => {
  const v = evaluateFreshness(
    [
      source({ timestamp: null, as_of: null }),
      source({ timestamp: "not-a-date", as_of: null }),
      source({ stale_after_hours: 0 }),
      source({ stale_after_hours: "nope" }),
    ],
    NOW,
  );
  assert.deepEqual(v.stale, []);
  assert.equal(v.skipped, 4);
  assert.equal(v.checked, 0);
});

test("as_of is the fallback stamp when timestamp is absent", () => {
  const v = evaluateFreshness(
    [source({ timestamp: undefined, as_of: hoursAgo(20) })],
    NOW,
  );
  assert.equal(v.stale.length, 1);
  assert.equal(v.stale[0].ageHours, 20);
});

test("a non-array sources field yields an empty verdict rather than throwing", () => {
  for (const bad of [null, undefined, {}, "sources", 7]) {
    const v = evaluateFreshness(bad, NOW);
    assert.deepEqual(v.stale, []);
    assert.equal(v.checked, 0);
  }
});

// The distinction that decides urgency: a required blocking source going stale
// means the publish pipeline is broken, which is not the same event as a pile of
// optional adapters aging out together.
test("critical is only blocking AND required", () => {
  const v = evaluateFreshness(
    [
      source({
        id: "a",
        timestamp: hoursAgo(30),
        stale_behavior: "block",
        required_for_publish: true,
      }),
      source({
        id: "b",
        timestamp: hoursAgo(30),
        stale_behavior: "block",
        required_for_publish: false,
      }),
      source({
        id: "c",
        timestamp: hoursAgo(30),
        stale_behavior: "warn",
        required_for_publish: true,
      }),
    ],
    NOW,
  );
  assert.equal(v.stale.length, 3);
  assert.deepEqual(
    v.critical.map((s) => s.id),
    ["a"],
  );
});

test("stale sources are ordered oldest-first", () => {
  const v = evaluateFreshness(
    [
      source({ id: "young", timestamp: hoursAgo(13) }),
      source({ id: "ancient", timestamp: hoursAgo(99) }),
      source({ id: "middle", timestamp: hoursAgo(40) }),
    ],
    NOW,
  );
  assert.deepEqual(
    v.stale.map((s) => s.id),
    ["ancient", "middle", "young"],
  );
});

test("defaults fill in for missing id, lane and behavior", () => {
  const v = evaluateFreshness(
    [{ timestamp: hoursAgo(20), stale_after_hours: 12 }],
    NOW,
  );
  assert.equal(v.stale[0].id, "unknown");
  assert.equal(v.stale[0].lane, "unknown");
  assert.equal(v.stale[0].behavior, "warn");
  assert.equal(v.stale[0].required, false);
});

// The signature must identify the CONDITION, not the tick -- otherwise a
// standing outage produces a new signature every hour as ages tick up, and the
// de-dup below never suppresses anything.
test("the signature is stable as a standing stall ages", () => {
  const at = (h: number) =>
    evaluateFreshness([source({ timestamp: hoursAgo(h) })], NOW).signature;
  assert.equal(at(13), at(40));
  assert.notEqual(at(13), "");
});

test("the signature is order-independent", () => {
  const a = evaluateFreshness(
    [
      source({ id: "x", timestamp: hoursAgo(20) }),
      source({ id: "y", timestamp: hoursAgo(30) }),
    ],
    NOW,
  ).signature;
  const b = evaluateFreshness(
    [
      source({ id: "y", timestamp: hoursAgo(30) }),
      source({ id: "x", timestamp: hoursAgo(20) }),
    ],
    NOW,
  ).signature;
  assert.equal(a, b);
});

test("shouldReport stays quiet while healthy and while unchanged", () => {
  const clean = evaluateFreshness([source()], NOW);
  assert.equal(shouldReport(clean, null), false);
  assert.equal(shouldReport(clean, ""), false);
  const stale = evaluateFreshness([source({ timestamp: hoursAgo(20) })], NOW);
  assert.equal(shouldReport(stale, stale.signature), false);
});

test("shouldReport fires when a stall starts, changes, and clears", () => {
  const stale = evaluateFreshness([source({ timestamp: hoursAgo(20) })], NOW);
  assert.equal(shouldReport(stale, null), true, "starts");
  const worse = evaluateFreshness(
    [
      source({ id: "x", timestamp: hoursAgo(20) }),
      source({ id: "y", timestamp: hoursAgo(20) }),
    ],
    NOW,
  );
  assert.equal(shouldReport(worse, stale.signature), true, "changes");
  const clean = evaluateFreshness([source()], NOW);
  assert.equal(shouldReport(clean, stale.signature), true, "clears");
});

// ---- cron wiring ----

function envWith(kv?: Record<string, unknown>) {
  return { METAGRAPH_CONTROL: kv } as unknown as Parameters<
    typeof runFreshnessWatchdog
  >[0];
}

const staleArtifact = {
  sources: [
    source({
      id: "a",
      timestamp: new Date(Date.now() - 40 * 3_600_000).toISOString(),
    }),
  ],
};

test("the tick reports and persists the signature on a new stall", async () => {
  const puts: Record<string, string> = {};
  const kv = {
    get: async () => null,
    put: async (k: string, v: string) => {
      puts[k] = v;
    },
  };
  const res = (await runFreshnessWatchdog(envWith(kv), undefined, {
    readArtifact: (async () => staleArtifact) as never,
  })) as Record<string, unknown>;
  assert.equal(res.ok, true);
  assert.equal(res.reported, true);
  assert.equal(res.stale_count, 1);
  assert.equal(Object.keys(puts).length, 1);
});

test("the tick stays quiet when the same stall is already recorded", async () => {
  let wrote = false;
  const signature = evaluateFreshness(
    staleArtifact.sources,
    Date.now(),
  ).signature;
  const kv = {
    get: async () => signature,
    put: async () => {
      wrote = true;
    },
  };
  const res = (await runFreshnessWatchdog(envWith(kv), undefined, {
    readArtifact: (async () => staleArtifact) as never,
  })) as Record<string, unknown>;
  assert.equal(res.reported, false);
  assert.equal(wrote, false);
});

// A noisy alarm beats an absent one: without KV there is no memory, so it must
// still report rather than go silent.
test("the tick still reports when the KV binding is absent", async () => {
  const res = (await runFreshnessWatchdog(envWith(undefined), undefined, {
    readArtifact: (async () => staleArtifact) as never,
  })) as Record<string, unknown>;
  assert.equal(res.reported, true);
});

test("a missing artifact degrades to a no-op, not a throw", async () => {
  const res = (await runFreshnessWatchdog(envWith(undefined), undefined, {
    readArtifact: (async () => null) as never,
  })) as Record<string, unknown>;
  assert.deepEqual(res, { ok: false, reason: "artifact_unavailable" });
});

test("an artifact read that throws degrades to a no-op", async () => {
  const res = (await runFreshnessWatchdog(envWith(undefined), undefined, {
    readArtifact: (async () => {
      throw new Error("r2 down");
    }) as never,
  })) as Record<string, unknown>;
  assert.deepEqual(res, { ok: false, reason: "unreachable" });
});

// A total publish stall makes every source stale at once; the alert body must
// stay readable.
test("the reported lists are bounded", async () => {
  const many = {
    sources: Array.from({ length: 40 }, (_, i) =>
      source({
        id: `s${i}`,
        timestamp: new Date(Date.now() - 50 * 3_600_000).toISOString(),
        stale_behavior: "block",
        required_for_publish: true,
      }),
    ),
  };
  const res = (await runFreshnessWatchdog(envWith(undefined), undefined, {
    readArtifact: (async () => many) as never,
  })) as Record<string, unknown>;
  assert.equal(res.stale_count, 40);
  assert.equal((res.stale as unknown[]).length, 10);
  assert.equal((res.critical as unknown[]).length, 10);
});

// A KV failure must not take the tick down -- it only costs the de-dup memory.
test("KV get/put failures do not fail the tick", async () => {
  const kv = {
    get: async () => {
      throw new Error("kv get down");
    },
    put: async () => {
      throw new Error("kv put down");
    },
  };
  const res = (await runFreshnessWatchdog(envWith(kv), undefined, {
    readArtifact: (async () => staleArtifact) as never,
  })) as Record<string, unknown>;
  assert.equal(res.ok, true);
  assert.equal(res.reported, true);
});

test("waitUntil receives the telemetry write when a context is present", async () => {
  const scheduled: unknown[] = [];
  const res = (await runFreshnessWatchdog(
    envWith(undefined),
    { waitUntil: (p: unknown) => scheduled.push(p) } as never,
    { readArtifact: (async () => staleArtifact) as never },
  )) as Record<string, unknown>;
  assert.equal(res.reported, true);
  assert.equal(scheduled.length, 1);
});

// ---- the durable record (#9440) ----
//
// shouldReport deliberately suppresses a repeat of the same signature, so a
// lane critical for six hours notifies once and then goes quiet -- correct for
// a notification, useless as a record. Everything this watchdog computed lived
// only in the return value, and workers/api.entry.ts discards what `scheduled`
// returns: measured every tick, then dropped. These pin the row per tick.

function laneHealthSpy() {
  const rows: Record<string, unknown>[] = [];
  return {
    rows,
    db: {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => ({
          run: async () => {
            // Only the INSERT carries a verdict; recordLaneVerdict also issues
            // a retention DELETE on the way through.
            if (sql.startsWith("INSERT")) {
              rows.push({
                lane: values[0],
                verdict: values[1],
                age_ms: values[2],
                detail: values[3],
              });
            }
          },
        }),
      }),
    },
  };
}

test("records an ok verdict on a tick that found nothing stale", async () => {
  const spy = laneHealthSpy();
  await runFreshnessWatchdog(envWith(undefined), undefined, {
    // Timestamped against the REAL clock, not the NOW fixture the pure
    // evaluateFreshness tests use: this path calls Date.now() itself, so a
    // fixture-dated source reads as stale by however long ago the fixture is.
    readArtifact: (async () => ({
      sources: [source({ timestamp: new Date().toISOString() })],
    })) as never,
    laneHealthDb: spy.db as never,
  });
  assert.equal(spy.rows.length, 1);
  assert.equal(spy.rows[0].lane, "freshness");
  assert.equal(spy.rows[0].verdict, "ok");
  assert.equal(spy.rows[0].detail, null);
});

test("records a stale verdict naming the sources, not just a count", async () => {
  const spy = laneHealthSpy();
  await runFreshnessWatchdog(envWith(undefined), undefined, {
    readArtifact: (async () => staleArtifact) as never,
    laneHealthDb: spy.db as never,
  });
  assert.equal(spy.rows.length, 1);
  assert.equal(spy.rows[0].verdict, "stale");
  // "which source" is the first question asked of a stale verdict, and the
  // count is derivable from the names -- not the other way round.
  assert.ok(String(spy.rows[0].detail).includes("a"));
});

test("records a row on EVERY tick, including one shouldReport suppresses", async () => {
  const spy = laneHealthSpy();
  const signature = evaluateFreshness(
    staleArtifact.sources,
    Date.now(),
  ).signature;
  const res = (await runFreshnessWatchdog(
    envWith({ get: async () => signature, put: async () => {} }),
    undefined,
    {
      readArtifact: (async () => staleArtifact) as never,
      laneHealthDb: spy.db as never,
    },
  )) as Record<string, unknown>;
  // The notification is correctly suppressed as a repeat...
  assert.equal(res.reported, false);
  // ...and the record is written anyway. This is the case the whole change
  // exists for: a stall in its sixth hour notifies nobody and must still be
  // visible somewhere.
  assert.equal(spy.rows.length, 1);
  assert.equal(spy.rows[0].verdict, "stale");
});

test("records `unknown` when the artifact cannot be read", async () => {
  const spy = laneHealthSpy();
  const res = (await runFreshnessWatchdog(envWith(undefined), undefined, {
    readArtifact: (async () => null) as never,
    laneHealthDb: spy.db as never,
  })) as Record<string, unknown>;
  assert.equal(res.ok, false);
  assert.equal(spy.rows.length, 1);
  // NOT a synonym for ok: the watchdog could not evaluate the lane at all.
  // Without this row, a watchdog that cannot read its own artifact and one
  // reporting everything fresh both produce silence.
  assert.equal(spy.rows[0].verdict, "unknown");
  assert.equal(spy.rows[0].detail, "artifact_unavailable");
});

test("records `unknown` when the tick throws outright", async () => {
  const spy = laneHealthSpy();
  const res = (await runFreshnessWatchdog(envWith(undefined), undefined, {
    readArtifact: (async () => {
      throw new Error("R2 unreachable");
    }) as never,
    laneHealthDb: spy.db as never,
  })) as Record<string, unknown>;
  assert.equal(res.ok, false);
  assert.equal(spy.rows.length, 1);
  assert.equal(spy.rows[0].verdict, "unknown");
  assert.equal(spy.rows[0].detail, "unreachable");
});

test("a lane_health write that fails never breaks the tick", async () => {
  // D1 migrations here are applied by hand, so an unapplied migration means
  // "no such table" on a live deployment. A watchdog whose alarm-recording
  // broke its alarm would be worse than the bug being fixed.
  const res = (await runFreshnessWatchdog(envWith(undefined), undefined, {
    readArtifact: (async () => staleArtifact) as never,
    laneHealthDb: {
      prepare: () => {
        throw new Error("no such table: lane_health");
      },
    } as never,
  })) as Record<string, unknown>;
  assert.equal(res.ok, true);
  assert.equal(res.stale_count, 1);
});
