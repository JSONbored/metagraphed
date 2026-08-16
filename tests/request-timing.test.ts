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
} from "../src/request-timing.ts";

describe("request timing", () => {
  test("MARKS FROM CONCURRENT REQUESTS DO NOT MIX", async () => {
    // The property that decides the whole design. The repo's other
    // collect-from-deep mechanism (`degradedSnapshot`) is a module global and
    // documents that a concurrent request can label this one -- defensible for
    // a boolean that errs safe, indefensible for a number, where bleed does not
    // degrade the answer, it invents one.
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
