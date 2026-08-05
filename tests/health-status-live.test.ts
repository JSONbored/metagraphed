// src/health-status-live.ts (#9522) — the probe-status continuity read.
//
// This helper exists because the previous route through tryPostgresTier could
// not be fixed without collateral: METAGRAPH_HEALTH_SOURCE is shared with
// /api/v1/health/trends, /api/v1/incidents and /api/v1/internal/compare-health,
// none of which data-api implements, so adding it to DATA_API_D1_FLAGS would
// have made all three forward, take a non-2xx, and emit a
// capturePostgresTierFallback exception per request.
//
// So the contract has two halves and both are pinned below: the flag still
// decides WHETHER to ask, and every failure mode answers with an empty array
// rather than throwing — a prober run that cannot read prior state must still
// probe.
import assert from "node:assert/strict";
import { test } from "vitest";
import { readLiveSurfaceStatus } from "../src/health-status-live.ts";

type Row = Record<string, unknown>;

const ROWS = [{ surface_id: "a", last_ok: 1000, consecutive_failures: 2 }];

function env(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const base = {
    METAGRAPH_HEALTH_SOURCE: "d1",
    DATA_API: {
      async fetch(request: Request) {
        calls.push(request.url);
        return new Response(JSON.stringify({ rows: ROWS }), { status: 200 });
      },
    },
    ...overrides,
  } as unknown as Env;
  return { env: base, calls };
}

test("returns the rows the route serves", async () => {
  const { env: e, calls } = env();
  assert.deepEqual(await readLiveSurfaceStatus(e, 0), ROWS);
  assert.equal(calls.length, 1);
});

test("asks for every surface when since is 0, and filters when it is not", async () => {
  const { env: e, calls } = env();
  await readLiveSurfaceStatus(e, 0);
  assert.equal(new URL(calls[0]).searchParams.get("since"), "0");
  await readLiveSurfaceStatus(e, 12_345);
  assert.equal(new URL(calls[1]).searchParams.get("since"), "12345");
});

// A NaN or negative cutoff must collapse to 0 (everything), never into the
// query string, where it would filter the whole table out and silently
// reproduce the empty prior map this route exists to fix.
test("normalizes an unusable since to 0 rather than passing it through", async () => {
  const { env: e, calls } = env();
  await readLiveSurfaceStatus(e, Number.NaN);
  await readLiveSurfaceStatus(e, -5);
  await readLiveSurfaceStatus(e, 9.9);
  assert.deepEqual(
    calls.map((url) => new URL(url).searchParams.get("since")),
    ["0", "0", "9"],
  );
});

// --- the flag still gates the read -----------------------------------------

test("does not reach the tier when the flag names none", async () => {
  for (const value of [undefined, "", "retired", "postgress"]) {
    const { env: e, calls } = env({ METAGRAPH_HEALTH_SOURCE: value });
    assert.deepEqual(await readLiveSurfaceStatus(e, 0), [], String(value));
    assert.equal(calls.length, 0, `must not call DATA_API for ${value}`);
  }
});

test("reaches the tier for both flag values that name one", async () => {
  for (const value of ["d1", "postgres"]) {
    const { env: e, calls } = env({ METAGRAPH_HEALTH_SOURCE: value });
    assert.deepEqual(await readLiveSurfaceStatus(e, 0), ROWS, value);
    assert.equal(calls.length, 1);
  }
});

// --- every failure mode degrades to an empty array -------------------------

test("returns empty with no env at all", async () => {
  assert.deepEqual(await readLiveSurfaceStatus(null, 0), []);
  assert.deepEqual(await readLiveSurfaceStatus(undefined, 0), []);
});

test("returns empty when the service binding is absent", async () => {
  const { env: e } = env({ DATA_API: undefined });
  assert.deepEqual(await readLiveSurfaceStatus(e, 0), []);
});

test("returns empty when the binding has no fetch", async () => {
  const { env: e } = env({ DATA_API: {} });
  assert.deepEqual(await readLiveSurfaceStatus(e, 0), []);
});

test("returns empty when the fetch throws", async () => {
  const { env: e } = env({
    DATA_API: {
      async fetch() {
        throw new Error("binding exploded");
      },
    },
  });
  assert.deepEqual(await readLiveSurfaceStatus(e, 0), []);
});

test("returns empty on a non-2xx", async () => {
  const { env: e } = env({
    DATA_API: {
      async fetch() {
        return new Response("nope", { status: 503 });
      },
    },
  });
  assert.deepEqual(await readLiveSurfaceStatus(e, 0), []);
});

test("returns empty on an unparseable body", async () => {
  const { env: e } = env({
    DATA_API: {
      async fetch() {
        return new Response("not json", { status: 200 });
      },
    },
  });
  assert.deepEqual(await readLiveSurfaceStatus(e, 0), []);
});

test("returns empty when the body carries no rows array", async () => {
  for (const body of ["null", "{}", '{"rows":null}', '{"rows":"nope"}']) {
    const { env: e } = env({
      DATA_API: {
        async fetch() {
          return new Response(body, { status: 200 });
        },
      },
    });
    assert.deepEqual(
      (await readLiveSurfaceStatus(e, 0)) as Row[],
      [],
      `body ${body}`,
    );
  }
});
