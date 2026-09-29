// Where a request's milliseconds went, as `Server-Timing`.
//
// Optimising the account routes on 2026-08-16 meant guessing: the same request
// measured 1.8s and 8.8s twenty minutes apart, and the tell that it was not the
// code came from a route nobody had touched -- `/blocks/{ref}` moved
// 0.196s -> 4.65s in the same window, because the shared Neon compute was
// contended. Three optimisations were made against numbers that could not
// distinguish any of that.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  mark,
  requestTimings,
  serverTimingHeader,
  timed,
  TIMING_NEON,
  TIMING_R2,
  TIMING_R2_SQL,
  withRequestTiming,
  withOperationTiming,
} from "../src/request-timing.ts";

describe("request timing", () => {
  test("concurrent operations retain independent marks and aggregate into HTTP timing", async () => {
    await withRequestTiming(async () => {
      mark("d1", 3);
      const snapshots = await Promise.all(
        [10, 20].map((duration) =>
          withOperationTiming(async () => {
            mark("d1", duration);
            await Promise.resolve();
            await withRequestTiming(async () => mark("d1_sql", duration / 10));
            return requestTimings();
          }),
        ),
      );
      assert.deepEqual(
        snapshots.map((m) => m?.get("d1")),
        [
          { durationMs: 10, count: 1 },
          { durationMs: 20, count: 1 },
        ],
      );
      assert.deepEqual(requestTimings()?.get("d1"), {
        durationMs: 33,
        count: 3,
      });
      assert.deepEqual(requestTimings()?.get("d1_sql"), {
        durationMs: 3,
        count: 2,
      });
      mark("d1", 7);
      assert.deepEqual(snapshots[0]?.get("d1"), { durationMs: 10, count: 1 });
    });
    assert.equal(requestTimings(), null);
  });

  test("isolated failures retain parent timing and work without a parent scope", async () => {
    await withRequestTiming(async () => {
      const failure = new Error("storage timeout");
      await assert.rejects(
        withOperationTiming(async () => {
          mark("d1", 15);
          throw failure;
        }),
        (error) => error === failure,
      );
      assert.deepEqual(requestTimings()?.get("d1"), {
        durationMs: 15,
        count: 1,
      });
    });
    assert.equal(await withOperationTiming(async () => 42), 42);
    assert.equal(requestTimings(), null);
  });

  test("MARKS FROM CONCURRENT REQUESTS DO NOT MIX", async () => {
    // Concurrent requests must never inherit each other's measurements.
    const seen: (string | null)[] = [];
    await Promise.all([
      withRequestTiming(async () => {
        mark(TIMING_NEON, 10);
        // Yield, so the other request runs inside this one's scope.
        await Promise.resolve();
        mark(TIMING_NEON, 10);
        seen.push(serverTimingHeader());
      }),
      withRequestTiming(async () => {
        mark(TIMING_R2_SQL, 500);
        await Promise.resolve();
        seen.push(serverTimingHeader());
      }),
    ]);
    assert.deepEqual(seen.sort(), [
      `neon;dur=20;desc="2 calls"`,
      `r2sql;dur=500;desc="1 call"`,
    ]);
  });

  test("THE CALL COUNT IS WHAT NAMES THE TIER", async () => {
    // `r2sql;count=0` beside `neon;count=2` IS "served from the hot tier", so
    // no separate header can disagree with it. That is why the count rides
    // along rather than the duration alone.
    const header = await withRequestTiming(async () => {
      mark(TIMING_R2, 40);
      mark(TIMING_R2, 35);
      mark(TIMING_NEON, 3);
      return serverTimingHeader();
    });
    assert.equal(
      header,
      `r2;dur=75;desc="2 calls"`.concat(`, neon;dur=3;desc="1 call"`),
    );
  });

  test("NOTHING MEASURED EMITS NO HEADER", async () => {
    // ~40 routes touch no store at all. An empty header on those is noise.
    assert.equal(
      await withRequestTiming(async () => serverTimingHeader()),
      null,
    );
  });

  test("OUTSIDE A REQUEST SCOPE every entry point is inert", () => {
    // Cron ticks, queue consumers and direct unit calls all reach these
    // boundaries. They must cost a map lookup, not an allocation.
    assert.equal(requestTimings(), null);
    mark(TIMING_NEON, 99);
    assert.equal(serverTimingHeader(), null);
  });

  test("`timed` STILL RUNS ITS CALLBACK outside a scope", async () => {
    // The boundaries call it unconditionally; a version that skipped the work
    // when unscoped would break every cron that reads a store.
    let ran = false;
    const out = await timed(TIMING_NEON, async () => {
      ran = true;
      return 7;
    });
    assert.equal(out, 7);
    assert.equal(ran, true);
  });

  test("A THROWING BOUNDARY IS STILL MEASURED", async () => {
    // A boundary that threw still spent the time, and a request whose slowness
    // came from a read that timed out is exactly the one worth measuring --
    // dropping it would make this quietest about the requests it exists for.
    const header = await withRequestTiming(async () => {
      await timed(TIMING_R2_SQL, async () => {
        throw new Error("query aborted");
      }).catch(() => null);
      return serverTimingHeader();
    });
    assert.match(header ?? "", /^r2sql;dur=\d+;desc="1 call"$/);
  });

  test("A NESTED SCOPE REUSES THE OUTER ONE", async () => {
    // A handler that wraps itself must not silently drop what its caller
    // collected.
    const header = await withRequestTiming(async () => {
      mark(TIMING_NEON, 5);
      await withRequestTiming(async () => {
        mark(TIMING_NEON, 5);
      });
      return serverTimingHeader();
    });
    assert.equal(header, `neon;dur=10;desc="2 calls"`);
  });

  test("the header PARSES as the standard's own grammar", async () => {
    // The browser devtools panel is most of the value here, and it renders
    // `name;dur=<number>;desc="<string>"` -- anything else is dropped silently.
    const header = await withRequestTiming(async () => {
      mark(TIMING_NEON, 1);
      mark(TIMING_R2_SQL, 2);
      return serverTimingHeader();
    });
    for (const entry of (header ?? "").split(", ")) {
      assert.match(entry, /^[a-z0-9]+;dur=\d+(?:\.\d+)?;desc="[^"]*"$/, entry);
    }
  });
});
