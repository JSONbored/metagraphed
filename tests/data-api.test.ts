// Unit tests for the data Worker (workers/data-api.ts). The Postgres tier this
// file was originally written against -- the read dispatcher, the Postgres half
// of every dual-write sync route, and the postgres.js mock that stood in for it
// -- was deleted in #9193 along with the box it fronted. What remains is the D1
// write path (mocked against a recording D1 stub) and the auth/size/shape gates
// every internal sync route still answers with.
import { beforeEach, test, expect, vi } from "vitest";
import { POSTHOG_PROJECT_TOKEN_ENV } from "../src/usage-telemetry.ts";
import type { Row } from "./row-type.ts";

const { default: worker } = await import("../workers/data-api.ts");
const NEURONS_SYNC_SECRET = "test-neurons-sync-secret";
const NEURON_DAILY_BACKFILL_SECRET = "test-neuron-daily-backfill-secret";
const ROLLUP_SYNC_SECRET = "test-rollup-sync-secret";
const SUBNET_HYPERPARAMS_SYNC_SECRET = "test-subnet-hyperparams-sync-secret";
const SUBNET_LOCKS_SYNC_SECRET = "test-subnet-locks-sync-secret";
const ACCOUNT_IDENTITY_SYNC_SECRET = "test-account-identity-sync-secret";
const VALIDATOR_NOMINATOR_COUNTS_SYNC_SECRET =
  "test-validator-nominator-counts-sync-secret";
const SUBNET_IDENTITY_SYNC_SECRET = "test-subnet-identity-sync-secret";
const HEALTH_CHECKS_SYNC_SECRET = "test-health-checks-sync-secret";
const SUBNET_SNAPSHOT_SYNC_SECRET = "test-subnet-snapshot-sync-secret";
const RPC_USAGE_SYNC_SECRET = "test-rpc-usage-sync-secret";
const NOMINATOR_POSITIONS_SYNC_SECRET = "test-nominator-positions-sync-secret";
const ACCOUNT_BALANCES_SYNC_SECRET = "test-account-balances-sync-secret";
/** Statements the neurons-sync D1 write path prepared (#9146), so a test can
 *  assert the snapshot really reached the store rather than merely being
 *  acknowledged. */
const d1Calls = vi.hoisted((): { sql: string; values: unknown[] }[] => []);
/** Set by a test to make the next D1 batch reject, for the failure paths. */
const d1Failure = vi.hoisted((): { error: Error | null } => ({ error: null }));

const env = {
  METAGRAPH_HEALTH_DB: {
    prepare(sql: string) {
      const entry = { sql, values: [] as unknown[] };
      d1Calls.push(entry);
      return {
        bind(...values: unknown[]) {
          entry.values = values;
          return {
            ...entry,
            // The hyperparams/identity syncs READ their D1 latest-hash state
            // through createD1Sql (prepare().bind().all()) before writing; an
            // empty result set means "cold history" -> every row diffs as
            // changed, which is the state this mocked suite wants.
            async all() {
              if (d1Failure.error) throw d1Failure.error;
              return { results: [] };
            },
          };
        },
      };
    },
    async batch(statements: unknown[]) {
      if (d1Failure.error) throw d1Failure.error;
      return statements.map(() => ({ success: true }));
    },
  },
  // The read families flag-switch on these (neuronsServedFromD1 /
  // matchHyperparamsIdentityD1Route): "postgres" keeps every read route in
  // this suite OFF the D1 lane, which since #9193 means it falls through to
  // the dispatcher's gone-tier 503. The D1 read lanes are exercised for real
  // in tests/data-api-neurons-d1.test.ts and
  // tests/data-api-hyperparams-identity-d1.test.ts. Writes ignore these flags.
  METAGRAPH_NEURONS_SOURCE: "postgres",
  METAGRAPH_SUBNET_HYPERPARAMS_SOURCE: "postgres",
  METAGRAPH_ACCOUNT_IDENTITY_SOURCE: "postgres",
  NEURONS_SYNC_SECRET,
  NEURON_DAILY_BACKFILL_SECRET,
  ROLLUP_SYNC_SECRET,
  SUBNET_HYPERPARAMS_SYNC_SECRET,
  SUBNET_LOCKS_SYNC_SECRET,
  ACCOUNT_IDENTITY_SYNC_SECRET,
  VALIDATOR_NOMINATOR_COUNTS_SYNC_SECRET,
  SUBNET_IDENTITY_SYNC_SECRET,
  HEALTH_CHECKS_SYNC_SECRET,
  SUBNET_SNAPSHOT_SYNC_SECRET,
  RPC_USAGE_SYNC_SECRET,
  NOMINATOR_POSITIONS_SYNC_SECRET,
  ACCOUNT_BALANCES_SYNC_SECRET,
};
const ctx = { waitUntil() {} } as unknown as ExecutionContext;
const req = (path: string, init?: RequestInit) =>
  worker.fetch(
    new Request(`https://d${path}`, init),
    env as unknown as Env,
    ctx as unknown as ExecutionContext,
  );
beforeEach(() => {
  d1Calls.length = 0;
  d1Failure.error = null;
});

// #4832 Tier 2: the live-`neurons` routes with no shared D1 loader (the
// handler builds its own inline SELECT) or a loader this Worker mirrors
// directly, matching the established metagraph/validators pattern above.

// #4832 Tier 2b: the neuron_daily-history routes -- structural history,
// concentration/performance/yield history, and chain/subnet turnover + movers
// (the boundary-snapshot routes translate SQLite's date(MAX(snapshot_date),
// '-N days') to Postgres's native `MAX(snapshot_date) - N::int`).

// #4832 gap-closure: GET /api/v1/accounts/:ss58/subnets/:netuid/history, the
// read path for the account_position_daily rollup added to handleNeuronsSync.

// #4771: POST /api/v1/internal/neurons-sync -- the one write route in this
// otherwise-read-only Worker (see workers/data-api.ts's handleNeuronsSync).
function neuronSyncRow(overrides = {}) {
  return {
    netuid: 8,
    uid: 3,
    hotkey: "5Hot",
    coldkey: "5Cold",
    active: 1,
    validator_permit: 1,
    rank: 1,
    trust: 0,
    validator_trust: 0.5,
    consensus: 0.4,
    incentive: 0.3,
    dividends: 0.2,
    emission_tao: 1.5,
    stake_tao: 100.25,
    registered_at_block: 1000,
    is_immunity_period: 0,
    axon: "1.2.3.4:9000",
    block_number: 5_000_000,
    captured_at: 1_780_000_000_000,
    ...overrides,
  };
}

function postNeurons(
  body: unknown,
  { secret, raw }: { secret?: string; raw?: string } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (secret !== undefined) headers["x-neurons-sync-token"] = secret;
  return req("/api/v1/internal/neurons-sync", {
    method: "POST",
    headers,
    body: raw !== undefined ? raw : JSON.stringify(body ?? []),
  });
}

test("neurons-sync rejects a missing or wrong token (401)", async () => {
  const wrong = await postNeurons([neuronSyncRow()], { secret: "wrong" });
  expect(wrong.status).toBe(401);
  const missing = await postNeurons([neuronSyncRow()]);
  expect(missing.status).toBe(401);
});

test("neurons-sync is disabled (503) when NEURONS_SYNC_SECRET is not configured", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/neurons-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-neurons-sync-token": NEURONS_SYNC_SECRET,
      },
      body: JSON.stringify([neuronSyncRow()]),
    }),
    {} as unknown as Env,
    ctx,
  );
  expect(res.status).toBe(503);
});

test("neurons-sync answers 503 -- the Postgres tier it wrote to is gone (#9193)", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/neurons-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-neurons-sync-token": NEURONS_SYNC_SECRET,
      },
      body: JSON.stringify([neuronSyncRow()]),
    }),
    { NEURONS_SYNC_SECRET } as unknown as Env,
    ctx,
  );
  expect(res.status).toBe(503);
});

test("neurons-sync rejects a body over the byte cap (413)", async () => {
  const res = await postNeurons(null, {
    secret: NEURONS_SYNC_SECRET,
    raw: "[" + "1".repeat(33_000_000) + "]",
  });
  expect(res.status).toBe(413);
});

test("neurons-sync rejects malformed JSON (400)", async () => {
  const res = await postNeurons(null, {
    secret: NEURONS_SYNC_SECRET,
    raw: "{not json",
  });
  expect(res.status).toBe(400);
});

test("neurons-sync rejects a body that isn't an array or {rows:[...]} (400)", async () => {
  const res = await postNeurons(
    { not: "an array" },
    { secret: NEURONS_SYNC_SECRET },
  );
  expect(res.status).toBe(400);
});

test("neurons-sync accepts the {rows:[...]} wrapped form, not just a bare array", async () => {
  const res = await postNeurons(
    { rows: [neuronSyncRow()] },
    { secret: NEURONS_SYNC_SECRET },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as Row;
  expect(body.neurons_written).toBe(1);
});

test("neurons-sync rejects more than the row cap (413)", async () => {
  const many = Array.from({ length: 50_001 }, (_, i) =>
    neuronSyncRow({ uid: i % 65_536 }),
  );
  const res = await postNeurons(many, { secret: NEURONS_SYNC_SECRET });
  expect(res.status).toBe(413);
});

test("neurons-sync rejects rows with an out-of-range netuid/uid (400)", async () => {
  const netuid = await postNeurons([neuronSyncRow({ netuid: 70_000 })], {
    secret: NEURONS_SYNC_SECRET,
  });
  expect(netuid.status).toBe(400);
  const uid = await postNeurons([neuronSyncRow({ uid: 70_000 })], {
    secret: NEURONS_SYNC_SECRET,
  });
  expect(uid.status).toBe(400);
});

test("neurons-sync rejects a non-object row (400)", async () => {
  const res = await postNeurons(["not-an-object"], {
    secret: NEURONS_SYNC_SECRET,
  });
  expect(res.status).toBe(400);
});

test("neurons-sync rejects a row carrying an unknown column (400)", async () => {
  const res = await postNeurons([neuronSyncRow({ unexpected_field: "nope" })], {
    secret: NEURONS_SYNC_SECRET,
  });
  expect(res.status).toBe(400);
});

test.each([
  ["null", null],
  ["a non-object primitive", "not-a-row"],
  ["a nested array", [1, 2, 3]],
])(
  "neurons-sync rejects a row that is %s (400, not a throw)",
  async (_label, malformedRow) => {
    const res = await postNeurons([neuronSyncRow(), malformedRow], {
      secret: NEURONS_SYNC_SECRET,
    });
    expect(res.status).toBe(400);
  },
);

test("neurons-sync rejects a row with a string field over the byte cap (400)", async () => {
  const res = await postNeurons([neuronSyncRow({ hotkey: "5".repeat(600) })], {
    secret: NEURONS_SYNC_SECRET,
  });
  expect(res.status).toBe(400);
});

test("neurons-sync rejects a row with a numeric field that overflows to Infinity (400)", async () => {
  // JSON.stringify(NaN) silently serializes to `null` (not a reproduction of
  // this check), but a raw oversized literal like 1e400 is syntactically
  // valid JSON that JSON.parse genuinely parses to Infinity -- a real,
  // reachable way a non-finite number arrives here.
  const { stake_tao: _stakeTao, ...rest } = neuronSyncRow();
  const raw = JSON.stringify([rest]).replace(/}\]$/, `,"stake_tao":1e400}]`);
  const res = await postNeurons(null, { secret: NEURONS_SYNC_SECRET, raw });
  expect(res.status).toBe(400);
});

test("neurons-sync rejects a row carrying a nested object/array value instead of a scalar (400)", async () => {
  const res = await postNeurons(
    [neuronSyncRow({ hotkey: ["not", "a", "scalar"] })],
    { secret: NEURONS_SYNC_SECRET },
  );
  expect(res.status).toBe(400);
});

test("neurons-sync rejects a row missing a valid captured_at (400)", async () => {
  const res = await postNeurons([neuronSyncRow({ captured_at: 0 })], {
    secret: NEURONS_SYNC_SECRET,
  });
  expect(res.status).toBe(400);
});

test("neurons-sync rejects a SECONDS-precision captured_at (400) (#9382)", async () => {
  // The case the old `captured_at > 0` check accepted, and the one that actually
  // reached production. Read as milliseconds this is 1970-01-21, which is the
  // snapshot_date the row would have been filed under -- and because neuron_daily
  // upserts under `captured_at <= excluded.captured_at`, a stamp 1000x too small is
  // permanently "older" than any correct capture, so the bad row could never be
  // repaired in place by a later one.
  const seconds = Math.floor(Date.UTC(2026, 7, 2) / 1000);
  const res = await postNeurons([neuronSyncRow({ captured_at: seconds })], {
    secret: NEURONS_SYNC_SECRET,
  });
  expect(res.status).toBe(400);
});

test("neurons-sync accepts a normal millisecond captured_at (#9382)", async () => {
  // The floor must not reject real captures -- the guard is about the unit, not
  // about being strict.
  const res = await postNeurons(
    [neuronSyncRow({ captured_at: Date.UTC(2026, 7, 2) })],
    { secret: NEURONS_SYNC_SECRET },
  );
  expect(res.status).toBe(200);
});

test("neurons-sync rejects an empty array (400)", async () => {
  const res = await postNeurons([], { secret: NEURONS_SYNC_SECRET });
  expect(res.status).toBe(400);
});

test("neurons-sync writes to D1 with no Postgres tier at all -- the wipe case (#9146)", async () => {
  // The whole point of the D1 port, and now the only path: without it this
  // handler would answer 503 to every sync now that the box is wiped, and the
  // only live-refreshed family in the product would stop advancing.
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/neurons-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-neurons-sync-token": NEURONS_SYNC_SECRET,
      },
      body: JSON.stringify([neuronSyncRow()]),
    }),
    env as unknown as Env,
    ctx as unknown as ExecutionContext,
  );
  expect(res.status, "with no Postgres, D1 is the only store").toEqual(200);
  const body = (await res.json()) as Row;
  expect(body.stores, "with no Postgres, D1 is the only store").toEqual(["d1"]);
  expect(
    body.neurons_written,
    "the snapshot must reach D1, not merely be acknowledged",
  ).toEqual(1);
  // And it really wrote: the snapshot reached D1, it was not just acknowledged.
  expect(
    d1Calls.some((call) => call.sql.startsWith("INSERT INTO neurons")),
    "the snapshot must reach D1, not merely be acknowledged",
  ).toBe(true);
});

test("neurons-sync fails the whole sync when D1 rejects (#9146)", async () => {
  // D1 is where this data lives once the box is gone, so a D1 failure is a
  // LOST snapshot -- it must not be reported as a success just because
  // Postgres still happened to accept the same rows.
  d1Failure.error = new Error("d1 down");
  const res = await postNeurons([neuronSyncRow()], {
    secret: NEURONS_SYNC_SECRET,
  });
  expect(res.status, "d1 write failed").toEqual(502);
  expect(((await res.json()) as Row).error).toBe("d1 write failed");
});

test("neurons-sync skips account_position_daily for a row with a null hotkey", async () => {
  const { hotkey: _hotkey, ...rest } = neuronSyncRow();
  const res = await postNeurons([{ ...rest, hotkey: null }], {
    secret: NEURONS_SYNC_SECRET,
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as Row;
  expect(body.account_position_daily_written).toBe(0);
  expect(
    d1Calls.some((call) =>
      call.sql.startsWith("INSERT INTO account_position_daily"),
    ),
  ).toBe(false);
});

// dispatchDataApiRequest's own route handlers all return a controlled error
// Response rather than throwing -- the only realistic way for the default
// export's try/catch (ok = false; throw error;) to actually run is
// something genuinely unexpected escaping past all of that, like the
// request body stream itself erroring mid-read (handleNeuronsSync's `await
// request.text()` is not wrapped in its own try/catch).
test("a body stream that errors mid-read still records ok:false on the trace span, and propagates", async () => {
  const posted: Row[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    posted.push({ url, body: JSON.parse(init.body as string) });
    return { ok: true };
  }) as unknown as typeof globalThis.fetch;
  const brokenBody = new ReadableStream({
    start(controller) {
      controller.error(new Error("client disconnected mid-upload"));
    },
  });
  const request = new Request("https://d/api/v1/internal/neurons-sync", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-neurons-sync-token": NEURONS_SYNC_SECRET,
    },
    // @ts-expect-error -- duplex is required by undici for a streaming body
    // but isn't in the RequestInit type this codebase targets.
    duplex: "half",
    body: brokenBody,
  });
  try {
    await expect(
      worker.fetch(
        request,
        {
          ...env,
          [POSTHOG_PROJECT_TOKEN_ENV]: "phc_test_token",
          POSTHOG_TRACES_SAMPLE_RATE: "1",
        } as unknown as Env,
        ctx,
      ),
    ).rejects.toThrow();
  } finally {
    globalThis.fetch = original;
  }
  // #9440: an uncaught fault now posts TWO things -- the span this test was
  // written for, and an $exception carrying the stack. Selected by shape
  // rather than by index so neither assertion depends on POST ordering.
  const spans = posted.filter((p) => p.body.resourceSpans);
  expect(spans.length).toBe(1);
  const span = spans[0].body.resourceSpans[0].scopeSpans[0].spans[0];
  expect(span.status.code).toBe(2); // ERROR

  const exceptions = posted.filter((p) => p.body.event === "$exception");
  expect(exceptions.length).toBe(1);
  expect(exceptions[0].body.properties.route).toBe(
    "/api/v1/internal/neurons-sync",
  );
});

// POST /api/v1/internal/backfill-neuron-daily -- deep-history ingest for
// scripts/backfill-neuron-history.py and scripts/backfill-stake-monthly.py
// (workers/data-api.ts's handleNeuronDailyBackfill). Same row shape as
// neurons-sync (reuses neuronSyncRow), different route/secret, and critically
// must NEVER touch the latest-only `neurons` table.
function postNeuronDailyBackfill(
  body: unknown,
  { secret, raw }: { secret?: string; raw?: string } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (secret !== undefined) headers["x-neuron-daily-backfill-token"] = secret;
  return req("/api/v1/internal/backfill-neuron-daily", {
    method: "POST",
    headers,
    body: raw !== undefined ? raw : JSON.stringify(body ?? []),
  });
}

test("backfill-neuron-daily rejects a missing or wrong token (401)", async () => {
  const wrong = await postNeuronDailyBackfill([neuronSyncRow()], {
    secret: "wrong",
  });
  expect(wrong.status).toBe(401);
  const missing = await postNeuronDailyBackfill([neuronSyncRow()]);
  expect(missing.status).toBe(401);
});

test("backfill-neuron-daily is disabled (503) when NEURON_DAILY_BACKFILL_SECRET is not configured", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/backfill-neuron-daily", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-neuron-daily-backfill-token": NEURON_DAILY_BACKFILL_SECRET,
      },
      body: JSON.stringify([neuronSyncRow()]),
    }),
    {} as unknown as Env,
    ctx,
  );
  expect(res.status).toBe(503);
});

test("backfill-neuron-daily answers 503 -- the Postgres tier it wrote to is gone (#9193)", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/backfill-neuron-daily", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-neuron-daily-backfill-token": NEURON_DAILY_BACKFILL_SECRET,
      },
      body: JSON.stringify([neuronSyncRow()]),
    }),
    { NEURON_DAILY_BACKFILL_SECRET } as unknown as Env,
    ctx,
  );
  expect(res.status).toBe(503);
});

test("backfill-neuron-daily rejects malformed JSON (400)", async () => {
  const res = await postNeuronDailyBackfill(null, {
    secret: NEURON_DAILY_BACKFILL_SECRET,
    raw: "{not json",
  });
  expect(res.status).toBe(400);
});

test("backfill-neuron-daily rejects a body that isn't an array or {rows:[...]} (400)", async () => {
  const res = await postNeuronDailyBackfill(
    { not: "an array" },
    { secret: NEURON_DAILY_BACKFILL_SECRET },
  );
  expect(res.status).toBe(400);
});

test("backfill-neuron-daily rejects more than the row cap (413)", async () => {
  const many = Array.from({ length: 50_001 }, (_, i) =>
    neuronSyncRow({ uid: i % 65_536 }),
  );
  const res = await postNeuronDailyBackfill(many, {
    secret: NEURON_DAILY_BACKFILL_SECRET,
  });
  expect(res.status).toBe(413);
});

test("backfill-neuron-daily accepts a null stake_tao (backfill-neuron-history.py's deferred-stake row)", async () => {
  const res = await postNeuronDailyBackfill(
    [neuronSyncRow({ stake_tao: null })],
    { secret: NEURON_DAILY_BACKFILL_SECRET },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as Row;
  expect(body.ok).toBe(true);
  expect(body.neuron_daily_written).toBe(1);
});

// stripClientSnapshotDate's own null/non-object/array guard (mirrors
// validNeuronSyncRow's identical guard, workers/data-api.ts) -- each malformed
// row still fails validation with the same 400, never a crash on destructuring.
test.each([
  ["null", null],
  ["a non-object primitive", "not-a-row"],
  ["a nested array", [1, 2, 3]],
])(
  "backfill-neuron-daily rejects a row that is %s (400, not a throw)",
  async (_label, malformedRow) => {
    const res = await postNeuronDailyBackfill([neuronSyncRow(), malformedRow], {
      secret: NEURON_DAILY_BACKFILL_SECRET,
    });
    expect(res.status).toBe(400);
  },
);

test("backfill-neuron-daily accepts the {rows:[...]} wrapped form, not just a bare array", async () => {
  const res = await postNeuronDailyBackfill(
    { rows: [neuronSyncRow()] },
    { secret: NEURON_DAILY_BACKFILL_SECRET },
  );
  expect(res.status).toBe(200);
  expect(((await res.json()) as Row).neuron_daily_written).toBe(1);
});

test("backfill-neuron-daily rejects a body over the byte cap (413)", async () => {
  const res = await postNeuronDailyBackfill(null, {
    secret: NEURON_DAILY_BACKFILL_SECRET,
    raw: "[" + "1".repeat(33_000_000) + "]",
  });
  expect(res.status).toBe(413);
});

test("backfill-neuron-daily rejects rows that don't match the neuron row shape (400)", async () => {
  const res = await postNeuronDailyBackfill(
    [neuronSyncRow({ netuid: 70_000 })],
    { secret: NEURON_DAILY_BACKFILL_SECRET },
  );
  expect(res.status).toBe(400);
});

test("backfill-neuron-daily excludes a null-hotkey row from account_position_daily", async () => {
  const res = await postNeuronDailyBackfill([neuronSyncRow({ hotkey: null })], {
    secret: NEURON_DAILY_BACKFILL_SECRET,
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as Row;
  expect(body.neuron_daily_written).toBe(1);
  expect(body.account_position_daily_written).toBe(0);
});

test("POST to a different path is rejected with 405 (neurons-sync route only accepts its own path)", async () => {
  const res = await req("/api/v1/chain-events", { method: "POST" });
  expect(res.status).toBe(405);
});

test("a read route with no D1 lane answers the gone-tier 503", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/chain-events"),
    {} as unknown as Env,
    ctx,
  );
  expect(res.status).toBe(503);
});

// account_events-derived analytics routes (#4826): D1's account_events copy is
// frozen since the streamer stopped; these port each D1-only analytics route to
// this already-live Postgres account_events table. Every build*/window map is
// reused unchanged from its D1 sibling module (pure, store-agnostic) -- only the
// query + response-shape wiring is new here.

// #4832 gap-closure: POST /api/v1/internal/rollup-account-events-daily -- the
// account_events_daily write path account_events itself lacked (indexer-rs
// writes account_events continuously, but nothing rolled it into the daily
// summary table in Postgres), plus its read path,
// GET /api/v1/accounts/:ss58/history.
function postRollup({ secret }: { secret?: string } = {}) {
  const headers: Record<string, string> = {};
  if (secret !== undefined) headers["x-rollup-sync-token"] = secret;
  return req("/api/v1/internal/rollup-account-events-daily", {
    method: "POST",
    headers,
  });
}

test("rollup-account-events-daily rejects a missing or wrong token (401)", async () => {
  const wrong = await postRollup({ secret: "wrong" });
  expect(wrong.status).toBe(401);
  const missing = await postRollup();
  expect(missing.status).toBe(401);
});

test("rollup-account-events-daily is disabled (503) when ROLLUP_SYNC_SECRET is not configured", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/rollup-account-events-daily", {
      method: "POST",
      headers: { "x-rollup-sync-token": ROLLUP_SYNC_SECRET },
    }),
    {} as unknown as Env,
    ctx,
  );
  expect(res.status).toBe(503);
});

test("rollup-account-events-daily answers 503 -- the Postgres tier it wrote to is gone (#9193)", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/rollup-account-events-daily", {
      method: "POST",
      headers: { "x-rollup-sync-token": ROLLUP_SYNC_SECRET },
    }),
    { ROLLUP_SYNC_SECRET } as unknown as Env,
    ctx,
  );
  expect(res.status).toBe(503);
});

// #4832 gap-closure: POST /api/v1/internal/subnet-hyperparams-sync -- the
// write path into subnet_hyperparams/subnet_hyperparams_history (see
// workers/data-api.ts's handleSubnetHyperparamsSync), plus its read paths,
// GET /api/v1/subnets/:netuid/hyperparameters[/history].
function hyperparamsSyncRow(overrides = {}) {
  return {
    netuid: 8,
    kappa_ratio: 0.5,
    immunity_period: 7200,
    min_allowed_weights: 8,
    max_weight_limit_ratio: 1,
    tempo: 360,
    weights_version: 1,
    weights_rate_limit: 100,
    activity_cutoff: 5000,
    activity_cutoff_factor: 1,
    registration_allowed: 1,
    target_regs_per_interval: 1,
    min_burn_tao: 0.001,
    max_burn_tao: 100,
    burn_half_life: 100_000,
    burn_increase_mult: 1,
    bonds_moving_avg_raw: 900_000,
    max_regs_per_block: 1,
    serving_rate_limit: 50,
    max_validators: 64,
    commit_reveal_period: 1,
    commit_reveal_enabled: 0,
    alpha_high_ratio: 0.9,
    alpha_low_ratio: 0.1,
    liquid_alpha_enabled: 0,
    alpha_sigmoid_steepness: 10,
    yuma_version: 3,
    subnet_is_active: 1,
    transfers_enabled: 1,
    bonds_reset_enabled: 0,
    user_liquidity_enabled: 0,
    owner_cut_enabled: 1,
    owner_cut_auto_lock_enabled: 1,
    min_childkey_take_ratio: 0,
    block_number: 5_000_000,
    captured_at: 1_780_000_000_000,
    ...overrides,
  };
}

function postSubnetHyperparams(
  body: unknown,
  { secret, raw }: { secret?: string; raw?: string } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (secret !== undefined) headers["x-subnet-hyperparams-sync-token"] = secret;
  return req("/api/v1/internal/subnet-hyperparams-sync", {
    method: "POST",
    headers,
    body: raw !== undefined ? raw : JSON.stringify(body ?? []),
  });
}

test("subnet-hyperparams-sync rejects a missing or wrong token (401)", async () => {
  const wrong = await postSubnetHyperparams([hyperparamsSyncRow()], {
    secret: "wrong",
  });
  expect(wrong.status).toBe(401);
  const missing = await postSubnetHyperparams([hyperparamsSyncRow()]);
  expect(missing.status).toBe(401);
});

test("subnet-hyperparams-sync is disabled (503) when SUBNET_HYPERPARAMS_SYNC_SECRET is not configured", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/subnet-hyperparams-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-subnet-hyperparams-sync-token": SUBNET_HYPERPARAMS_SYNC_SECRET,
      },
      body: JSON.stringify([hyperparamsSyncRow()]),
    }),
    {} as unknown as Env,
    ctx,
  );
  expect(res.status).toBe(503);
});

test("subnet-hyperparams-sync answers 503 -- the Postgres tier it wrote to is gone (#9193)", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/subnet-hyperparams-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-subnet-hyperparams-sync-token": SUBNET_HYPERPARAMS_SYNC_SECRET,
      },
      body: JSON.stringify([hyperparamsSyncRow()]),
    }),
    { SUBNET_HYPERPARAMS_SYNC_SECRET } as unknown as Env,
    ctx,
  );
  expect(res.status).toBe(503);
});

test("subnet-hyperparams-sync rejects a body over the byte cap (413)", async () => {
  const res = await postSubnetHyperparams(null, {
    secret: SUBNET_HYPERPARAMS_SYNC_SECRET,
    raw: "[" + "1".repeat(2_000_000) + "]",
  });
  expect(res.status).toBe(413);
});

test("subnet-hyperparams-sync rejects malformed JSON (400)", async () => {
  const res = await postSubnetHyperparams(null, {
    secret: SUBNET_HYPERPARAMS_SYNC_SECRET,
    raw: "{not json",
  });
  expect(res.status).toBe(400);
});

test("subnet-hyperparams-sync rejects a body that isn't an array or {rows:[...]} (400)", async () => {
  const res = await postSubnetHyperparams(
    { not: "an array" },
    { secret: SUBNET_HYPERPARAMS_SYNC_SECRET },
  );
  expect(res.status).toBe(400);
});

test("subnet-hyperparams-sync accepts the {rows:[...]} wrapped form, not just a bare array", async () => {
  const res = await postSubnetHyperparams(
    { rows: [hyperparamsSyncRow()] },
    { secret: SUBNET_HYPERPARAMS_SYNC_SECRET },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as Row;
  expect(body.subnet_hyperparams_written).toBe(1);
});

test("subnet-hyperparams-sync rejects more than the row cap (413)", async () => {
  const many = Array.from({ length: 2001 }, (_, i) =>
    hyperparamsSyncRow({ netuid: i % 65_536 }),
  );
  const res = await postSubnetHyperparams(many, {
    secret: SUBNET_HYPERPARAMS_SYNC_SECRET,
  });
  expect(res.status).toBe(413);
});

test("subnet-hyperparams-sync rejects a row with an out-of-range netuid (400)", async () => {
  const res = await postSubnetHyperparams(
    [hyperparamsSyncRow({ netuid: 70_000 })],
    { secret: SUBNET_HYPERPARAMS_SYNC_SECRET },
  );
  expect(res.status).toBe(400);
});

test("subnet-hyperparams-sync rejects a non-object row (400)", async () => {
  const res = await postSubnetHyperparams(["not-an-object"], {
    secret: SUBNET_HYPERPARAMS_SYNC_SECRET,
  });
  expect(res.status).toBe(400);
});

test("subnet-hyperparams-sync rejects a row carrying an unknown column (400)", async () => {
  const res = await postSubnetHyperparams(
    [hyperparamsSyncRow({ unexpected_field: 1 })],
    { secret: SUBNET_HYPERPARAMS_SYNC_SECRET },
  );
  expect(res.status).toBe(400);
});

test("subnet-hyperparams-sync rejects a row with a non-numeric, non-null field (400)", async () => {
  const res = await postSubnetHyperparams(
    [hyperparamsSyncRow({ tempo: "360" })],
    { secret: SUBNET_HYPERPARAMS_SYNC_SECRET },
  );
  expect(res.status).toBe(400);
});

test("subnet-hyperparams-sync rejects a row with a numeric field that overflows to Infinity (400)", async () => {
  const { tempo: _tempo, ...rest } = hyperparamsSyncRow();
  const raw = JSON.stringify([rest]).replace(/}\]$/, `,"tempo":1e400}]`);
  const res = await postSubnetHyperparams(null, {
    secret: SUBNET_HYPERPARAMS_SYNC_SECRET,
    raw,
  });
  expect(res.status).toBe(400);
});

test("subnet-hyperparams-sync rejects a row missing a valid captured_at (400)", async () => {
  const res = await postSubnetHyperparams(
    [hyperparamsSyncRow({ captured_at: 0 })],
    { secret: SUBNET_HYPERPARAMS_SYNC_SECRET },
  );
  expect(res.status).toBe(400);
});

test("subnet-hyperparams-sync rejects an empty array (400)", async () => {
  const res = await postSubnetHyperparams([], {
    secret: SUBNET_HYPERPARAMS_SYNC_SECRET,
  });
  expect(res.status).toBe(400);
});

// #4832 gap-closure: POST /api/v1/internal/account-identity-sync -- the
// write path into account_identity/account_identity_history (see
// workers/data-api.ts's handleAccountIdentitySync), plus its read paths,
// GET /api/v1/accounts/:ss58/identity[-history]. Unlike subnet-hyperparams-
// sync, this route has NO prune step (see that handler's own comment).
const IDENTITY_SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

function accountIdentitySyncRow(overrides = {}) {
  return {
    account: IDENTITY_SS58,
    name: "Example Team",
    url: "https://miao.example/",
    github: "https://github.com/miao-team/miao-repo",
    image: "https://miao.example/logo.png",
    discord: "examplehandle",
    description: "An example subnet operator.",
    additional: null,
    captured_at: 1_780_000_000_000,
    ...overrides,
  };
}

function postAccountIdentity(
  body: unknown,
  { secret, raw }: { secret?: string; raw?: string } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (secret !== undefined) headers["x-account-identity-sync-token"] = secret;
  return req("/api/v1/internal/account-identity-sync", {
    method: "POST",
    headers,
    body: raw !== undefined ? raw : JSON.stringify(body ?? []),
  });
}

test("account-identity-sync rejects a missing or wrong token (401)", async () => {
  const wrong = await postAccountIdentity([accountIdentitySyncRow()], {
    secret: "wrong",
  });
  expect(wrong.status).toBe(401);
  const missing = await postAccountIdentity([accountIdentitySyncRow()]);
  expect(missing.status).toBe(401);
});

test("account-identity-sync is disabled (503) when ACCOUNT_IDENTITY_SYNC_SECRET is not configured", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/account-identity-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-account-identity-sync-token": ACCOUNT_IDENTITY_SYNC_SECRET,
      },
      body: JSON.stringify([accountIdentitySyncRow()]),
    }),
    {} as unknown as Env,
    ctx,
  );
  expect(res.status).toBe(503);
});

test("account-identity-sync answers 503 -- the Postgres tier it wrote to is gone (#9193)", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/account-identity-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-account-identity-sync-token": ACCOUNT_IDENTITY_SYNC_SECRET,
      },
      body: JSON.stringify([accountIdentitySyncRow()]),
    }),
    { ACCOUNT_IDENTITY_SYNC_SECRET } as unknown as Env,
    ctx,
  );
  expect(res.status).toBe(503);
});

test("account-identity-sync rejects a body over the byte cap (413)", async () => {
  const res = await postAccountIdentity(null, {
    secret: ACCOUNT_IDENTITY_SYNC_SECRET,
    raw: "[" + "1".repeat(5_000_000) + "]",
  });
  expect(res.status).toBe(413);
});

test("account-identity-sync rejects malformed JSON (400)", async () => {
  const res = await postAccountIdentity(null, {
    secret: ACCOUNT_IDENTITY_SYNC_SECRET,
    raw: "{not json",
  });
  expect(res.status).toBe(400);
});

test("account-identity-sync rejects a body that isn't an array or {rows:[...]} (400)", async () => {
  const res = await postAccountIdentity(
    { not: "an array" },
    { secret: ACCOUNT_IDENTITY_SYNC_SECRET },
  );
  expect(res.status).toBe(400);
});

test("account-identity-sync accepts the {rows:[...]} wrapped form, not just a bare array", async () => {
  const res = await postAccountIdentity(
    { rows: [accountIdentitySyncRow()] },
    { secret: ACCOUNT_IDENTITY_SYNC_SECRET },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as Row;
  expect(body.account_identity_written).toBe(1);
});

test("account-identity-sync rejects more than the row cap (413)", async () => {
  // Minimal rows (account + captured_at only, no other fields) so the total
  // body stays well under the byte cap -- otherwise a full accountIdentitySyncRow()
  // fixture repeated 20,001x would trip the byte-cap 413 first and mask
  // whether the row-cap check itself is reachable.
  const many = Array.from({ length: 20_001 }, () => ({
    account: "5X",
    captured_at: 1_780_000_000_000,
  }));
  const res = await postAccountIdentity(many, {
    secret: ACCOUNT_IDENTITY_SYNC_SECRET,
  });
  expect(res.status).toBe(413);
});

test("account-identity-sync rejects a row with a missing/empty account (400)", async () => {
  const res = await postAccountIdentity(
    [accountIdentitySyncRow({ account: "" })],
    { secret: ACCOUNT_IDENTITY_SYNC_SECRET },
  );
  expect(res.status).toBe(400);
});

test("account-identity-sync rejects a non-object row (400)", async () => {
  const res = await postAccountIdentity(["not-an-object"], {
    secret: ACCOUNT_IDENTITY_SYNC_SECRET,
  });
  expect(res.status).toBe(400);
});

test("account-identity-sync rejects a row carrying an unknown column (400)", async () => {
  const res = await postAccountIdentity(
    [accountIdentitySyncRow({ unexpected_field: "nope" })],
    { secret: ACCOUNT_IDENTITY_SYNC_SECRET },
  );
  expect(res.status).toBe(400);
});

test("account-identity-sync rejects a row with a numeric identity field (400)", async () => {
  // Unlike subnet-hyperparams-sync, every column but account/captured_at is
  // TEXT-only -- a bare number must be actively rejected here.
  const res = await postAccountIdentity(
    [accountIdentitySyncRow({ name: 123 })],
    { secret: ACCOUNT_IDENTITY_SYNC_SECRET },
  );
  expect(res.status).toBe(400);
});

test("account-identity-sync rejects a row with a string field over the byte cap (400)", async () => {
  const res = await postAccountIdentity(
    [accountIdentitySyncRow({ name: "x".repeat(1100) })],
    { secret: ACCOUNT_IDENTITY_SYNC_SECRET },
  );
  expect(res.status).toBe(400);
});

test("account-identity-sync rejects a row missing a finite captured_at (400)", async () => {
  const res = await postAccountIdentity(
    [accountIdentitySyncRow({ captured_at: "not-a-number" })],
    { secret: ACCOUNT_IDENTITY_SYNC_SECRET },
  );
  expect(res.status).toBe(400);
});

test("account-identity-sync rejects an empty array (400)", async () => {
  const res = await postAccountIdentity([], {
    secret: ACCOUNT_IDENTITY_SYNC_SECRET,
  });
  expect(res.status).toBe(400);
});

// #2549: POST /api/v1/internal/validator-nominator-counts-sync -- the write
// path into validator_nominator_counts (see workers/data-api.ts's
// handleValidatorNominatorCountsSync). Simpler than account-identity-sync
// above: latest-only upsert, no history/hash-diff table.
function validatorNominatorCountRow(overrides = {}) {
  return {
    hotkey: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
    nominator_count: 42,
    captured_at: 1_780_000_000_000,
    ...overrides,
  };
}

function postValidatorNominatorCounts(
  body: unknown,
  { secret, raw }: { secret?: string; raw?: string } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (secret !== undefined)
    headers["x-validator-nominator-counts-sync-token"] = secret;
  return req("/api/v1/internal/validator-nominator-counts-sync", {
    method: "POST",
    headers,
    body: raw !== undefined ? raw : JSON.stringify(body ?? []),
  });
}

test("validator-nominator-counts-sync rejects a missing or wrong token (401)", async () => {
  const wrong = await postValidatorNominatorCounts(
    [validatorNominatorCountRow()],
    { secret: "wrong" },
  );
  expect(wrong.status).toBe(401);
  const missing = await postValidatorNominatorCounts([
    validatorNominatorCountRow(),
  ]);
  expect(missing.status).toBe(401);
});

test("validator-nominator-counts-sync is disabled (503) when VALIDATOR_NOMINATOR_COUNTS_SYNC_SECRET is not configured", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/validator-nominator-counts-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-validator-nominator-counts-sync-token":
          VALIDATOR_NOMINATOR_COUNTS_SYNC_SECRET,
      },
      body: JSON.stringify([validatorNominatorCountRow()]),
    }),
    {} as unknown as Env,
    ctx,
  );
  expect(res.status).toBe(503);
});

test("validator-nominator-counts-sync answers 503 when no store is bound (#9146)", async () => {
  // Was "the Postgres tier it wrote to is gone (#9193)". The lane is no longer
  // retired -- migration 0012 gave it a D1 store and the handler writes there
  // (tests/data-api-validator-nominator-counts-d1.test.ts covers the write
  // against a real database). What this env pins is the remaining 503: an
  // authenticated, well-formed request with NOTHING bound to write to.
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/validator-nominator-counts-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-validator-nominator-counts-sync-token":
          VALIDATOR_NOMINATOR_COUNTS_SYNC_SECRET,
      },
      body: JSON.stringify([validatorNominatorCountRow()]),
    }),
    { VALIDATOR_NOMINATOR_COUNTS_SYNC_SECRET } as unknown as Env,
    ctx,
  );
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ error: "d1 binding unavailable" });
});

// #5233: POST /api/v1/internal/nominator-positions-sync -- the write path
// into nominator_positions (see workers/data-api.ts's
// handleNominatorPositionsSync). Same latest-only-upsert shape as
// validator-nominator-counts-sync above, just a wider composite key.
function nominatorPositionRow(overrides = {}) {
  return {
    coldkey: "5Cold1",
    hotkey: "5Hk1",
    netuid: 3,
    share_fraction: 0.25,
    captured_at: 1_780_000_000_000,
    ...overrides,
  };
}

function postNominatorPositions(
  body: unknown,
  { secret, raw }: { secret?: string; raw?: string } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (secret !== undefined)
    headers["x-nominator-positions-sync-token"] = secret;
  return req("/api/v1/internal/nominator-positions-sync", {
    method: "POST",
    headers,
    body: raw !== undefined ? raw : JSON.stringify(body ?? []),
  });
}

test("nominator-positions-sync rejects a missing or wrong token (401)", async () => {
  const wrong = await postNominatorPositions([nominatorPositionRow()], {
    secret: "nope",
  });
  expect(wrong.status).toBe(401);
  const missing = await postNominatorPositions([nominatorPositionRow()]);
  expect(missing.status).toBe(401);
});

test("nominator-positions-sync is disabled (503) when NOMINATOR_POSITIONS_SYNC_SECRET is not configured", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/nominator-positions-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nominator-positions-sync-token": NOMINATOR_POSITIONS_SYNC_SECRET,
      },
      body: JSON.stringify([nominatorPositionRow()]),
    }),
    { ...env, NOMINATOR_POSITIONS_SYNC_SECRET: undefined } as unknown as Env,
    ctx,
  );
  expect(res.status).toBe(503);
});

test("nominator-positions-sync writes to D1 -- the lane is live again (#9273)", async () => {
  // It answered 503 for the whole period the ledger was frozen (#9193 retired
  // it with the box), which is why /accounts/{ss58}/positions served a stamp
  // that could never advance. The end-to-end write contract lives in
  // tests/data-api-nominator-positions-d1.test.ts against a real SQLite
  // database; this asserts only that the route no longer dead-ends here.
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/nominator-positions-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nominator-positions-sync-token": NOMINATOR_POSITIONS_SYNC_SECRET,
      },
      body: JSON.stringify([nominatorPositionRow()]),
    }),
    env as unknown as Env,
    ctx,
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    ok: true,
    nominator_positions_written: 1,
    stores: ["d1"],
  });
});

// #6638: POST /api/v1/internal/subnet-locks-sync -- the write path into
// subnet_locks (see workers/data-api.ts's handleSubnetLocksSync). Its whole
// body-validation-and-upsert half went with the Postgres tier in #9193, so
// what is left to pin is the pair of auth gates that still run and the
// answer every authenticated call now gets.
function postSubnetLocks(body: unknown, { secret }: { secret?: string } = {}) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (secret !== undefined) headers["x-subnet-locks-sync-token"] = secret;
  return req("/api/v1/internal/subnet-locks-sync", {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? []),
  });
}

test("subnet-locks-sync rejects a missing or wrong token (401)", async () => {
  const wrong = await postSubnetLocks([], { secret: "nope" });
  expect(wrong.status).toBe(401);
  const missing = await postSubnetLocks([]);
  expect(missing.status).toBe(401);
});

test("subnet-locks-sync is disabled (503) when SUBNET_LOCKS_SYNC_SECRET is not configured", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/subnet-locks-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-subnet-locks-sync-token": SUBNET_LOCKS_SYNC_SECRET,
      },
      body: "[]",
    }),
    { ...env, SUBNET_LOCKS_SYNC_SECRET: undefined } as unknown as Env,
    ctx,
  );
  expect(res.status).toBe(503);
});

test("subnet-locks-sync answers 503 -- the Postgres tier it wrote to is gone (#9193)", async () => {
  const res = await postSubnetLocks([], { secret: SUBNET_LOCKS_SYNC_SECRET });
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ error: "hyperdrive binding unavailable" });
});

// #6742: POST /api/v1/internal/account-balances-sync -- the write path into
// account_balances (see workers/data-api.ts's handleAccountBalancesSync).
// Same latest-only-upsert shape as nominator-positions-sync above, a
// single-column key instead of a composite one.
function accountBalanceRow(overrides = {}) {
  return {
    ss58: "5Whale1",
    free_tao: 1000.5,
    reserved_tao: 25.25,
    captured_at: 1_780_000_000_000,
    ...overrides,
  };
}

function postAccountBalances(
  body: unknown,
  { secret, raw }: { secret?: string; raw?: string } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (secret !== undefined) headers["x-account-balances-sync-token"] = secret;
  return req("/api/v1/internal/account-balances-sync", {
    method: "POST",
    headers,
    body: raw !== undefined ? raw : JSON.stringify(body ?? []),
  });
}

test("account-balances-sync rejects a missing or wrong token (401)", async () => {
  const wrong = await postAccountBalances([accountBalanceRow()], {
    secret: "nope",
  });
  expect(wrong.status).toBe(401);
  const missing = await postAccountBalances([accountBalanceRow()]);
  expect(missing.status).toBe(401);
});

test("account-balances-sync is disabled (503) when ACCOUNT_BALANCES_SYNC_SECRET is not configured", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/account-balances-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-account-balances-sync-token": ACCOUNT_BALANCES_SYNC_SECRET,
      },
      body: JSON.stringify([accountBalanceRow()]),
    }),
    { ...env, ACCOUNT_BALANCES_SYNC_SECRET: undefined } as unknown as Env,
    ctx,
  );
  expect(res.status).toBe(503);
});

test("account-balances-sync writes to D1 -- the lane is live again (#9478)", async () => {
  // It answered 503 for the whole period top-holders was frozen (#9193 retired
  // it with the box), which is why /api/v1/accounts/top-holders served a
  // `captured_at` stuck at 2026-08-02. The end-to-end write contract lives in
  // tests/data-api-account-balances-d1.test.ts against a real SQLite database;
  // this asserts only that the route no longer dead-ends here.
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/account-balances-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-account-balances-sync-token": ACCOUNT_BALANCES_SYNC_SECRET,
      },
      body: JSON.stringify([accountBalanceRow()]),
    }),
    env as unknown as Env,
    ctx,
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    ok: true,
    account_balances_written: 1,
    stores: ["d1"],
  });
});

const SUBNET_IDENTITY_NETUID = 8;

function subnetIdentityProfile(overrides = {}) {
  return {
    netuid: SUBNET_IDENTITY_NETUID,
    symbol: "MIAO",
    native_identity: {
      subnet_name: "Miao Subnet",
      description: "An example subnet operator.",
      github_url: "https://github.com/miao-team/miao-repo",
      website_url: "https://miao.example/",
      discord: "examplehandle",
      logo_url: "https://miao.example/logo.png",
    },
    ...overrides,
  };
}

function postSubnetIdentity(
  body: unknown,
  { secret, raw }: { secret?: string; raw?: string } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (secret !== undefined) headers["x-subnet-identity-sync-token"] = secret;
  return req("/api/v1/internal/subnet-identity-sync", {
    method: "POST",
    headers,
    body: raw !== undefined ? raw : JSON.stringify(body ?? []),
  });
}

test("subnet-identity-sync rejects a missing or wrong token (401)", async () => {
  const wrong = await postSubnetIdentity([subnetIdentityProfile()], {
    secret: "wrong",
  });
  expect(wrong.status).toBe(401);
  const missing = await postSubnetIdentity([subnetIdentityProfile()]);
  expect(missing.status).toBe(401);
});

test("subnet-identity-sync is disabled (503) when SUBNET_IDENTITY_SYNC_SECRET is not configured", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/subnet-identity-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-subnet-identity-sync-token": SUBNET_IDENTITY_SYNC_SECRET,
      },
      body: JSON.stringify([subnetIdentityProfile()]),
    }),
    {} as unknown as Env,
    ctx,
  );
  expect(res.status).toBe(503);
});

test("subnet-identity-sync answers 503 -- the Postgres tier it wrote to is gone (#9193)", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/subnet-identity-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-subnet-identity-sync-token": SUBNET_IDENTITY_SYNC_SECRET,
      },
      body: JSON.stringify([subnetIdentityProfile()]),
    }),
    { SUBNET_IDENTITY_SYNC_SECRET } as unknown as Env,
    ctx,
  );
  expect(res.status).toBe(503);
});

// #4832 gap-closure: health-checks-sync -- best-effort Postgres mirror of
// src/health-prober.ts's D1+KV write, called from the main Worker's own
// 15-minute cron (syncHealthChecksToPostgres), not an external workflow.
function probedRow(overrides = {}) {
  return {
    surface_id: "sn-1-example-api",
    surface_key: "srf-abc123",
    netuid: 1,
    kind: "subnet-api",
    provider: "example",
    url: "https://example.com/api",
    status: "ok",
    classification: "healthy",
    latency_ms: 120,
    status_code: 200,
    checked_at_ms: 1780000000000,
    last_ok_ms: 1780000000000,
    consecutive_failures: 0,
    ...overrides,
  };
}

function postHealthChecks(
  body: unknown,
  { secret, raw }: { secret?: string; raw?: string } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (secret !== undefined) headers["x-health-checks-sync-token"] = secret;
  return req("/api/v1/internal/health-checks-sync", {
    method: "POST",
    headers,
    body: raw !== undefined ? raw : JSON.stringify(body ?? { probed: [] }),
  });
}

test("health-checks-sync rejects a missing or wrong token (401)", async () => {
  const wrong = await postHealthChecks(
    { probed: [probedRow()] },
    { secret: "wrong" },
  );
  expect(wrong.status).toBe(401);
  const missing = await postHealthChecks({ probed: [probedRow()] });
  expect(missing.status).toBe(401);
});

test("health-checks-sync is disabled (503) when HEALTH_CHECKS_SYNC_SECRET is not configured", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/health-checks-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-health-checks-sync-token": HEALTH_CHECKS_SYNC_SECRET,
      },
      body: JSON.stringify({ probed: [probedRow()] }),
    }),
    {} as unknown as Env,
    ctx,
  );
  expect(res.status).toBe(503);
});

test("health-checks-sync answers 503 -- the Postgres tier it wrote to is gone (#9193)", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/health-checks-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-health-checks-sync-token": HEALTH_CHECKS_SYNC_SECRET,
      },
      body: JSON.stringify({ probed: [probedRow()] }),
    }),
    { HEALTH_CHECKS_SYNC_SECRET } as unknown as Env,
    ctx,
  );
  expect(res.status).toBe(503);
});

// #4832 gap-closure: health-uptime-rollup-sync -- best-effort Postgres
// mirror of rollupDailyUptime, reusing HEALTH_CHECKS_SYNC_SECRET (same
// conceptual sync boundary, not a separate secret). Unlike health-checks-
// sync, the body carries only UTC day boundaries; Postgres computes its own
// rollup from its own surface_checks via PERCENTILE_CONT.
function dayBounds(date: string, start: number, end: number) {
  return { date, start, end };
}

function postHealthUptimeRollup(
  body: unknown,
  { secret, raw }: { secret?: string; raw?: string } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (secret !== undefined) headers["x-health-checks-sync-token"] = secret;
  return req("/api/v1/internal/health-uptime-rollup-sync", {
    method: "POST",
    headers,
    body:
      raw !== undefined
        ? raw
        : JSON.stringify(body ?? { days: [], updated_at: 1 }),
  });
}

test("health-uptime-rollup-sync rejects a missing or wrong token (401)", async () => {
  const wrong = await postHealthUptimeRollup(
    { days: [dayBounds("2026-07-11", 1, 2)], updated_at: 1 },
    { secret: "wrong" },
  );
  expect(wrong.status).toBe(401);
  const missing = await postHealthUptimeRollup({
    days: [dayBounds("2026-07-11", 1, 2)],
    updated_at: 1,
  });
  expect(missing.status).toBe(401);
});

test("health-uptime-rollup-sync is disabled (503) when HEALTH_CHECKS_SYNC_SECRET is not configured", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/health-uptime-rollup-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-health-checks-sync-token": HEALTH_CHECKS_SYNC_SECRET,
      },
      body: JSON.stringify({
        days: [dayBounds("2026-07-11", 1, 2)],
        updated_at: 1,
      }),
    }),
    {} as unknown as Env,
    ctx,
  );
  expect(res.status).toBe(503);
});

test("health-uptime-rollup-sync answers 503 -- the Postgres tier it wrote to is gone (#9193)", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/health-uptime-rollup-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-health-checks-sync-token": HEALTH_CHECKS_SYNC_SECRET,
      },
      body: JSON.stringify({
        days: [dayBounds("2026-07-11", 1, 2)],
        updated_at: 1,
      }),
    }),
    { HEALTH_CHECKS_SYNC_SECRET } as unknown as Env,
    ctx,
  );
  expect(res.status).toBe(503);
});

// #4832 Tier 2: the 12 chain-wide account_events analytics routes
// (mirroring src/chain-*.mjs's D1 loaders). These reuse the ALREADY-flipped
// METAGRAPH_ACCOUNT_EVENTS_SOURCE flag (no new table/secret), so entities.ts
// -- err, analytics.ts's -- own tryPostgresTier wiring is tested at the
// handler layer (tests/chain-*.test.mjs); these exercise the actual SQL/
// shaping in workers/data-api.ts itself, including the cold-store guard
// branch each "network + subnet" route shares.

// #4832 gap-closure: extrinsics/blocks-derived cluster (handleChainActivity/
// Calls/Signers/Fees), the last D1-only routes among the "network-wide chain
// analytics" family. All 4 reuse METAGRAPH_EXTRINSICS_SOURCE (already
// "postgres" -- see wrangler.jsonc), the same flag Tier 1a's blocks/
// extrinsics routes already serve from. Live-verified via psql before
// writing this SQL (2026-07-11): the plain aggregates run well under 500ms
// at current volume (~1.2M extrinsics/7d), but COUNT(DISTINCT signer) and
// PERCENTILE_CONT median queries cost ~2.5-2.9s -- a thin margin under the
// 3s default -- so chain/activity and chain/fees widen their own budget via
// SET LOCAL, mirroring chain/transfers' fix (#4869).

// #4832 gap-closure: health-tracking read routes. All 5 read from
// surface_checks/surface_uptime_daily -- populated by the health-checks-sync
// / health-uptime-rollup-sync write routes -- and are gated behind the
// deliberately-unflipped METAGRAPH_HEALTH_SOURCE flag (see
// handleBulkHealthTrends' own header comment in
// workers/request-handlers/analytics.ts), so these tests only prove the
// SQL/routing wiring, matching every other route's test style regardless.

function rpcUsageEvent(overrides = {}) {
  return {
    observed_at: 1_718_323_200_000,
    network: "finney",
    endpoint_id: "fx",
    provider: "onfinality",
    ok: true,
    status: 200,
    attempts: 1,
    latency_ms: 140,
    cache: "miss",
    ...overrides,
  };
}

function postRpcUsageEvent(
  body: unknown,
  { secret, raw }: { secret?: string; raw?: string } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (secret !== undefined) headers["x-rpc-usage-sync-token"] = secret;
  return req("/api/v1/internal/rpc-usage-sync", {
    method: "POST",
    headers,
    body: raw !== undefined ? raw : JSON.stringify(body ?? rpcUsageEvent()),
  });
}

test("rpc-usage-sync rejects a missing or wrong token (401)", async () => {
  const wrong = await postRpcUsageEvent(rpcUsageEvent(), { secret: "wrong" });
  expect(wrong.status).toBe(401);
  const missing = await postRpcUsageEvent(rpcUsageEvent());
  expect(missing.status).toBe(401);
});

test("rpc-usage-sync is disabled (503) when RPC_USAGE_SYNC_SECRET is not configured", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/rpc-usage-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-rpc-usage-sync-token": RPC_USAGE_SYNC_SECRET,
      },
      body: JSON.stringify(rpcUsageEvent()),
    }),
    {} as unknown as Env,
    ctx,
  );
  expect(res.status).toBe(503);
});

test("rpc-usage-sync answers 503 -- the Postgres tier it wrote to is gone (#9193)", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/rpc-usage-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-rpc-usage-sync-token": RPC_USAGE_SYNC_SECRET,
      },
      body: JSON.stringify(rpcUsageEvent()),
    }),
    { RPC_USAGE_SYNC_SECRET } as unknown as Env,
    ctx,
  );
  expect(res.status).toBe(503);
});

function postRpcUsagePrune(
  body?: unknown,
  { secret, raw }: { secret?: string; raw?: string } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (secret !== undefined) headers["x-rpc-usage-sync-token"] = secret;
  return req("/api/v1/internal/rpc-usage-prune", {
    method: "POST",
    headers,
    body:
      raw !== undefined
        ? raw
        : JSON.stringify(body ?? { cutoff: 1_718_000_000_000 }),
  });
}

test("rpc-usage-prune rejects a missing or wrong token (401)", async () => {
  const wrong = await postRpcUsagePrune(undefined, { secret: "wrong" });
  expect(wrong.status).toBe(401);
  const missing = await postRpcUsagePrune();
  expect(missing.status).toBe(401);
});

test("rpc-usage-prune is disabled (503) when RPC_USAGE_SYNC_SECRET is not configured", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/rpc-usage-prune", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-rpc-usage-sync-token": RPC_USAGE_SYNC_SECRET,
      },
      body: JSON.stringify({ cutoff: 1_718_000_000_000 }),
    }),
    {} as unknown as Env,
    ctx,
  );
  expect(res.status).toBe(503);
});

test("rpc-usage-prune answers 503 -- the Postgres tier it wrote to is gone (#9193)", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/rpc-usage-prune", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-rpc-usage-sync-token": RPC_USAGE_SYNC_SECRET,
      },
      body: JSON.stringify({ cutoff: 1_718_000_000_000 }),
    }),
    { RPC_USAGE_SYNC_SECRET } as unknown as Env,
    ctx,
  );
  expect(res.status).toBe(503);
});
