// The lane that gives /api/v1/self-health something to say (#9836).
//
// The endpoint has reported `current_ok: null` and a `degraded` floor since
// 2026-08-02, when the indexer box's poller died with the box. That was the
// honest answer -- null means UNMEASURED, deliberately distinct from down --
// and the fix is not to change what the endpoint says, it is to measure again.
//
// So what these assert is mostly about the difference between "down" and
// "unmeasured", which is the distinction the whole endpoint turns on and the
// one a probe lane is most likely to erase.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  probeComponent,
  runSelfHealthProbe,
  SELF_HEALTH_PROBE_LANE,
  SELF_HEALTH_TARGETS,
} from "../src/self-health-prober.ts";
import { SELF_HEALTH_COMPONENTS } from "../src/self-health.ts";

/** A Postgres runner that records every statement. */
function recorder(failOn?: RegExp) {
  const seen: { text: string; values: unknown[] }[] = [];
  return {
    seen,
    sql: {
      unsafe: async (text: string, values: unknown[] = []) => {
        seen.push({ text, values });
        if (failOn?.test(text)) throw new Error("write failed");
        return [];
      },
    },
  };
}

function laneSpy() {
  const written: Record<string, unknown>[] = [];
  return {
    written,
    db: {
      prepare: () => ({
        bind: (...values: unknown[]) => ({
          run: async () => {
            written.push({ values });
            return {};
          },
          all: async () => ({ results: [] }),
        }),
      }),
    } as never,
  };
}

describe("probeComponent", () => {
  test("a 2xx or 3xx is up, a 4xx or 5xx is down, and both carry the status", async () => {
    for (const [status, ok] of [
      [200, true],
      [304, true],
      [404, false],
      [503, false],
    ] as const) {
      const result = await probeComponent("api", "https://x/y", {
        fetch: (async () => ({ status })) as never,
        now: () => 1000,
      });
      assert.equal(result.ok, ok, `status ${status}`);
      assert.equal(result.http_status, status);
    }
  });

  test("no response at all is down with a NULL status, not a synthesized one", async () => {
    // DNS, TLS, connect and timeout all land here. A null status is a
    // different fact from a 5xx -- "we never reached it" versus "it answered
    // badly" -- and flattening them loses the only signal that separates our
    // outage from theirs.
    const result = await probeComponent("api", "https://x/y", {
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as never,
      now: () => 1000,
    });
    assert.equal(result.ok, false);
    assert.equal(result.http_status, null);
  });

  test("a hung request is down rather than hanging the tick", async () => {
    // `wait` is injected rather than relying on setTimeout: this test passed
    // locally and hung for the full 30s vitest budget in CI, which is the same
    // shape as this repo's unresolved webhook-retry-timer case. What matters is
    // the timeout PATH, and that is testable without betting on a timer.
    const result = await probeComponent("api", "https://x/y", {
      fetch: (() => new Promise(() => {})) as never,
      wait: async () => undefined,
      timeoutMs: 5,
    });
    assert.equal(result.ok, false);
    assert.equal(result.http_status, null);
  });

  test("every component has a target, and none of them is /health", async () => {
    // /health answers from bindings alone and returns 200 while every read
    // behind it is broken. Probing it would publish a green self-health for a
    // completely dead API.
    for (const component of SELF_HEALTH_COMPONENTS) {
      const url = SELF_HEALTH_TARGETS[component];
      assert.ok(url, `${component} has no probe target`);
      assert.doesNotMatch(
        url!,
        /\/health(\?|$)/,
        `${component} probes /health`,
      );
    }
  });
});

describe("runSelfHealthProbe", () => {
  const okFetch = (async () => ({ status: 200 })) as never;

  test("writes a tick AND a rollup row for every component", async () => {
    const pg = recorder();
    const lane = laneSpy();
    const out = await runSelfHealthProbe(
      { HYPERDRIVE: {} },
      { waitUntil: () => undefined },
      {
        sql: pg.sql,
        laneHealthDb: lane.db,
        fetch: okFetch,
        now: () => 1_780_000_000_000,
      },
    );
    assert.equal(out.attempted, true);
    assert.equal(out.probed, SELF_HEALTH_COMPONENTS.length);
    const ticks = pg.seen.filter((s) =>
      /INSERT INTO self_health_checks/.test(s.text),
    );
    const rollups = pg.seen.filter((s) =>
      /INSERT INTO self_health_daily/.test(s.text),
    );
    assert.equal(ticks.length, SELF_HEALTH_COMPONENTS.length);
    assert.equal(rollups.length, SELF_HEALTH_COMPONENTS.length);
  });

  test("the rollup ADDS rather than recounting from the ticks", async () => {
    // The rollup is kept for 90 days and the ticks for ~14, so it has to
    // outlive its own evidence. A recount would silently shorten the published
    // history to the tick retention the first time anything was pruned.
    const pg = recorder();
    await runSelfHealthProbe(
      { HYPERDRIVE: {} },
      { waitUntil: () => undefined },
      { sql: pg.sql, laneHealthDb: laneSpy().db, fetch: okFetch },
    );
    const rollup = pg.seen.find((s) =>
      /INSERT INTO self_health_daily/.test(s.text),
    );
    assert.ok(rollup);
    assert.match(rollup!.text, /checks = self_health_daily\.checks \+ 1/);
    assert.doesNotMatch(rollup!.text, /SELECT[\s\S]*FROM self_health_checks/);
  });

  test("a DOWN component is still written -- an outage must not become an absence", async () => {
    // Absence in these tables means "not measured". If the lane skipped
    // writing when a probe failed, an outage would be indistinguishable from
    // the lane itself being broken, which is the exact confusion this
    // endpoint exists to resolve.
    const pg = recorder();
    const out = await runSelfHealthProbe(
      { HYPERDRIVE: {} },
      { waitUntil: () => undefined },
      {
        sql: pg.sql,
        laneHealthDb: laneSpy().db,
        fetch: (async () => ({ status: 500 })) as never,
      },
    );
    assert.equal(out.ok_count, 0);
    const ticks = pg.seen.filter((s) =>
      /INSERT INTO self_health_checks/.test(s.text),
    );
    assert.equal(ticks.length, SELF_HEALTH_COMPONENTS.length);
  });

  test("a failing probe is NOT a failing lane", async () => {
    // The lane verdict answers "could we measure", not "are we up". Alarming
    // on a down component would conflate an outage with a blind spot, and the
    // outage is already reported -- by the data this lane just stored.
    const lane = laneSpy();
    await runSelfHealthProbe(
      { HYPERDRIVE: {} },
      { waitUntil: () => undefined },
      {
        sql: recorder().sql,
        laneHealthDb: lane.db,
        fetch: (async () => ({ status: 500 })) as never,
      },
    );
    const values = lane.written[0]!.values as unknown[];
    assert.ok(
      values.includes("ok"),
      `lane verdict should be ok when the probe ran: ${JSON.stringify(values)}`,
    );
  });

  test("a failed WRITE is a failing lane", async () => {
    // The other side of the same rule: if the tick did not land, we did not
    // measure, whatever the probe returned.
    const lane = laneSpy();
    await runSelfHealthProbe(
      { HYPERDRIVE: {} },
      { waitUntil: () => undefined },
      {
        sql: recorder(/self_health_checks/).sql,
        laneHealthDb: lane.db,
        fetch: okFetch,
      },
    );
    const values = lane.written[0]!.values as unknown[];
    assert.ok(values.includes("stale"), JSON.stringify(values));
  });

  // "declines, and says so, when Neon does not own both tables" retired with NEON_SOLE_STORE_TABLES (#10051): Neon is the only
  // store, so the undeclared/partial state cannot exist; the binding pins
  // survive in this suite.

  test("declines without a runner rather than probing into the void", async () => {
    const out = await runSelfHealthProbe({}, null, {
      laneHealthDb: laneSpy().db,
      fetch: okFetch,
    });
    assert.equal(out.attempted, false);
    assert.equal(SELF_HEALTH_PROBE_LANE, "self-health-probe");
  });
});
