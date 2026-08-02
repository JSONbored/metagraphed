// POST /api/v1/internal/emission-gate-sync (#8748/#8750 restored): the D1
// persistence half of the emission-gate sampling lane. Auth/caps/shape checks
// mirror tests/chain-firehose-routes.test.ts's boundary coverage for api.ts's
// other secret-gated internal route; the diff-then-append behaviour executes
// against a REAL SQLite database built from migrations/d1/0005_emission_gate.sql
// (same rationale as tests/observations-d1-sqlite.test.ts: a fake records SQL
// but never parses it, and the riskiest constructs here -- the ROW_NUMBER()
// window reads that replace postgres's DISTINCT ON, and the two-arm shape
// CHECK on emission_flow_watch -- only fail at execution).
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, test } from "vitest";
import { handleRequest } from "../workers/api.ts";

const SCHEMA = fs.readFileSync(
  path.join(process.cwd(), "migrations/d1/0005_emission_gate.sql"),
  "utf8",
);

const SECRET = "emission-gate-test-secret";
const ROUTE = "https://api.metagraph.sh/api/v1/internal/emission-gate-sync";

let db: InstanceType<typeof DatabaseSync>;

// D1-shaped wrapper over node:sqlite: reads go through prepare().all() (D1's
// { results } envelope), writes through prepare().bind() collected into
// batch(), transactionally like the real thing.
function d1() {
  return {
    prepare(sql: string) {
      return {
        async all() {
          return { results: db.prepare(sql).all() };
        },
        bind(...values: unknown[]) {
          return { sql, values };
        },
      };
    },
    async batch(statements: { sql: string; values: unknown[] }[]) {
      db.exec("BEGIN");
      try {
        for (const statement of statements) {
          db.prepare(statement.sql).run(...(statement.values as never[]));
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return statements;
    },
  };
}

function env(over: Record<string, unknown> = {}) {
  return {
    EMISSION_GATE_SYNC_SECRET: SECRET,
    METAGRAPH_HEALTH_DB: d1(),
    ...over,
  } as unknown as Env;
}

// `token: null` omits the header entirely (an `undefined` argument would just
// re-trigger the destructuring default).
function syncRequest(
  body: string,
  {
    method = "POST",
    token = SECRET,
  }: { method?: string; token?: string | null } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (token !== null) headers["x-emission-gate-sync-token"] = token;
  return new Request(ROUTE, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : body,
  });
}

// A full healthy observation: four params (one null -- exponent unset means
// the runtime default), two subnets, all four flow params unset, one EMA at
// exactly the frozen baseline (dormant) and one subnet with no entry.
function baseBody(over: Record<string, unknown> = {}) {
  return {
    block_number: 8_500_000,
    observed_at: Date.parse("2026-08-02T12:00:00Z"),
    current: {
      emission_gate_bar: 0.42,
      emission_bar_quantile: 0.75,
      emission_gate_exponent: null,
      block_emission_halvings: 2,
    },
    current_enabled: [
      [1, true],
      [2, false],
    ],
    flow_observations: [
      { item: "net_tao_flow_enabled", raw: null },
      { item: "flow_norm_exponent", raw: null },
      { item: "tao_flow_cutoff", raw: null },
      { item: "flow_ema_smoothing_factor", raw: null },
    ],
    current_ema: [
      [1, { block: 8_466_530 }],
      [2, null],
    ],
    ...over,
  };
}

async function post(body: unknown, environment = env()) {
  return handleRequest(
    syncRequest(typeof body === "string" ? body : JSON.stringify(body)),
    environment,
    {},
  );
}

const count = (table: string) =>
  (db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
});

// --- auth / caps boundary ----------------------------------------------------

test("rejects non-POST before checking auth (405)", async () => {
  const res = await handleRequest(
    syncRequest("", { method: "GET" }),
    env(),
    {},
  );
  assert.equal(res.status, 405);
});

test("503s when EMISSION_GATE_SYNC_SECRET is unprovisioned", async () => {
  const res = await handleRequest(
    syncRequest("{}"),
    { METAGRAPH_HEALTH_DB: d1() } as unknown as Env,
    {},
  );
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, "emission_gate_sync_unavailable");
});

test("401s when the token header is missing", async () => {
  const res = await handleRequest(
    syncRequest("{}", { token: null }),
    env(),
    {},
  );
  assert.equal(res.status, 401);
  assert.equal(
    (await res.json()).error.code,
    "emission_gate_sync_unauthorized",
  );
});

test("401s on a wrong token", async () => {
  const res = await handleRequest(
    syncRequest("{}", { token: "wrong" }),
    env(),
    {},
  );
  assert.equal(res.status, 401);
});

test("503s when METAGRAPH_HEALTH_DB is not bound", async () => {
  const res = await handleRequest(
    syncRequest("{}"),
    { EMISSION_GATE_SYNC_SECRET: SECRET } as unknown as Env,
    {},
  );
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, "emission_gate_sync_unavailable");
});

test("413s a body over the byte cap", async () => {
  const res = await post(`{"pad":"${"x".repeat(1_000_001)}"}`);
  assert.equal(res.status, 413);
  assert.equal(
    (await res.json()).error.code,
    "emission_gate_sync_body_too_large",
  );
});

test("400s a non-JSON body", async () => {
  const res = await post("not json");
  assert.equal(res.status, 400);
  assert.equal(
    (await res.json()).error.code,
    "emission_gate_sync_invalid_body",
  );
});

// --- body shape --------------------------------------------------------------

const malformed: [string, unknown][] = [
  ["a JSON scalar", "5"],
  ["JSON null", "null"],
  ["a JSON array", "[]"],
  ["a negative block_number", baseBody({ block_number: -1 })],
  ["a non-integer block_number", baseBody({ block_number: 1.5 })],
  ["a zero observed_at", baseBody({ observed_at: 0 })],
  ["a missing observed_at", baseBody({ observed_at: undefined })],
  ["a null current", baseBody({ current: null })],
  ["an array current", baseBody({ current: [] })],
  ["an untracked gate parameter", baseBody({ current: { theta: 0.4 } })],
  [
    "a string parameter value",
    baseBody({ current: { emission_gate_bar: "0.42" } }),
  ],
  ["a non-array current_enabled", baseBody({ current_enabled: {} })],
  [
    "an oversized current_enabled",
    baseBody({ current_enabled: new Array(10_001).fill([1, true]) }),
  ],
  ["a non-array enabled pair", baseBody({ current_enabled: [5] })],
  ["a 3-tuple enabled pair", baseBody({ current_enabled: [[1, true, 0]] })],
  ["a non-integer netuid", baseBody({ current_enabled: [["1", true]] })],
  ["a negative netuid", baseBody({ current_enabled: [[-1, true]] })],
  ["an over-range netuid", baseBody({ current_enabled: [[70_000, true]] })],
  ["a non-boolean enabled value", baseBody({ current_enabled: [[1, "yes"]] })],
  ["a non-array flow_observations", baseBody({ flow_observations: {} })],
  [
    "an oversized flow_observations",
    baseBody({ flow_observations: new Array(10_001).fill(null) }),
  ],
  ["a null flow observation", baseBody({ flow_observations: [null] })],
  ["an array flow observation", baseBody({ flow_observations: [[]] })],
  [
    "a non-string flow item",
    baseBody({ flow_observations: [{ item: 5, raw: null }] }),
  ],
  [
    "an untracked flow item",
    baseBody({ flow_observations: [{ item: "bogus", raw: null }] }),
  ],
  [
    "a numeric flow raw",
    baseBody({ flow_observations: [{ item: "tao_flow_cutoff", raw: 5 }] }),
  ],
  [
    "an oversized flow raw",
    baseBody({
      flow_observations: [
        { item: "tao_flow_cutoff", raw: `0x${"a".repeat(300)}` },
      ],
    }),
  ],
  ["a non-array current_ema", baseBody({ current_ema: {} })],
  ["a scalar EMA entry value", baseBody({ current_ema: [[1, 5]] })],
  ["an array EMA entry value", baseBody({ current_ema: [[1, [8]]] })],
  ["an EMA entry without a block", baseBody({ current_ema: [[1, {}]] })],
  ["a negative EMA block", baseBody({ current_ema: [[1, { block: -1 }]] })],
];

for (const [what, body] of malformed) {
  test(`400s ${what}`, async () => {
    const res = await post(body);
    assert.equal(res.status, 400);
    assert.equal(
      (await res.json()).error.code,
      "emission_gate_sync_invalid_body",
    );
    assert.equal(count("emission_gate_param_history"), 0, "nothing written");
  });
}

test("400s a non-finite parameter value (JSON 1e999 parses to Infinity)", async () => {
  const raw = JSON.stringify(baseBody()).replace(
    '"emission_gate_bar":0.42',
    '"emission_gate_bar":1e999',
  );
  const res = await post(raw);
  assert.equal(res.status, 400);
});

// --- first run / idempotence --------------------------------------------------

test("first run appends predates_capture rows for every key, none alertable", async () => {
  const res = await post(baseBody());
  assert.equal(res.status, 200);
  const summary = await res.json();
  assert.deepEqual(summary, {
    ok: true,
    block_number: 8_500_000,
    gate_param_rows: 4,
    subnet_enabled_rows: 2,
    flow_watch_rows: 4,
    flow_alertable: 0,
    subnets_seen: 2,
    ema_entries_seen: 2,
    alertable: [],
  });
  assert.equal(count("emission_gate_param_history"), 4);
  assert.equal(count("subnet_emission_enabled_history"), 2);
  assert.equal(count("emission_flow_watch"), 4);
  const bar = db
    .prepare(
      "SELECT value, previous_value, source, predates_capture FROM emission_gate_param_history WHERE param = 'emission_gate_bar'",
    )
    .get() as Record<string, unknown>;
  assert.equal(bar.value, 0.42);
  assert.equal(bar.previous_value, null);
  assert.equal(bar.source, "runtime_recomputed");
  assert.equal(bar.predates_capture, 1);
  // The unset exponent is recorded as a NULL reading, not skipped.
  const exponent = db
    .prepare(
      "SELECT value FROM emission_gate_param_history WHERE param = 'emission_gate_exponent'",
    )
    .get() as Record<string, unknown>;
  assert.equal(exponent.value, null);
});

test("a second identical POST inserts nothing (idempotent no-change run)", async () => {
  await post(baseBody());
  const res = await post(baseBody());
  assert.equal(res.status, 200);
  const summary = await res.json();
  assert.equal(summary.gate_param_rows, 0);
  assert.equal(summary.subnet_enabled_rows, 0);
  assert.equal(summary.flow_watch_rows, 0);
  assert.equal(count("emission_gate_param_history"), 4);
  assert.equal(count("subnet_emission_enabled_history"), 2);
  assert.equal(count("emission_flow_watch"), 4);
});

// --- real changes -------------------------------------------------------------

test("a moved parameter appends one history row carrying previous_value", async () => {
  await post(baseBody());
  const res = await post(
    baseBody({
      block_number: 8_500_100,
      current: {
        emission_gate_bar: 0.5,
        emission_bar_quantile: 0.75,
        // null -> 3 IS a change: an explicit set to the default is governance.
        emission_gate_exponent: 3,
        block_emission_halvings: 2,
      },
    }),
  );
  const summary = await res.json();
  assert.equal(summary.gate_param_rows, 2);
  const bar = db
    .prepare(
      "SELECT value, previous_value, block_number, predates_capture FROM emission_gate_param_history WHERE param = 'emission_gate_bar' ORDER BY id DESC LIMIT 1",
    )
    .get() as Record<string, unknown>;
  assert.equal(bar.value, 0.5);
  assert.equal(bar.previous_value, 0.42);
  assert.equal(bar.block_number, 8_500_100);
  assert.equal(bar.predates_capture, 0);
  const exponent = db
    .prepare(
      "SELECT value, previous_value FROM emission_gate_param_history WHERE param = 'emission_gate_exponent' ORDER BY id DESC LIMIT 1",
    )
    .get() as Record<string, unknown>;
  assert.equal(exponent.value, 3);
  assert.equal(exponent.previous_value, null);
});

test("an enablement flip appends one row per flipped subnet, both directions", async () => {
  await post(baseBody());
  const res = await post(
    baseBody({
      current_enabled: [
        [1, false],
        [2, true],
      ],
    }),
  );
  const summary = await res.json();
  assert.equal(summary.subnet_enabled_rows, 2);
  const rows = db
    .prepare(
      "SELECT netuid, enabled, previous_enabled FROM subnet_emission_enabled_history WHERE predates_capture = 0 ORDER BY netuid",
    )
    .all() as Record<string, unknown>[];
  // node:sqlite rows are null-prototype objects; spread for strict deepEqual.
  assert.deepEqual(
    rows.map((row) => ({ ...row })),
    [
      { netuid: 1, enabled: 0, previous_enabled: 1 },
      { netuid: 2, enabled: 1, previous_enabled: 0 },
    ],
  );
});

test("a flow parameter becoming set (then unset) is recorded and alertable both times", async () => {
  await post(baseBody());
  const set = await post(
    baseBody({
      flow_observations: [
        { item: "net_tao_flow_enabled", raw: "0x01" },
        { item: "flow_norm_exponent", raw: null },
        { item: "tao_flow_cutoff", raw: null },
        { item: "flow_ema_smoothing_factor", raw: null },
      ],
    }),
  );
  const setSummary = await set.json();
  assert.equal(setSummary.flow_watch_rows, 1);
  assert.equal(setSummary.flow_alertable, 1);
  assert.deepEqual(setSummary.alertable, [
    { item: "net_tao_flow_enabled", netuid: null },
  ]);
  const unset = await post(baseBody());
  const unsetSummary = await unset.json();
  assert.equal(unsetSummary.flow_alertable, 1);
  const rows = db
    .prepare(
      "SELECT is_set FROM emission_flow_watch WHERE item = 'net_tao_flow_enabled' AND predates_capture = 0 ORDER BY id",
    )
    .all() as Record<string, unknown>[];
  assert.deepEqual(
    rows.map((row) => ({ ...row })),
    [{ is_set: 1 }, { is_set: 0 }],
  );
});

test("an EMA advanced past the frozen baseline is recorded and alertable", async () => {
  await post(baseBody());
  const res = await post(
    baseBody({
      current_ema: [
        [1, { block: 8_466_530 }],
        [2, null],
        [3, { block: 8_466_531 }],
      ],
    }),
  );
  const summary = await res.json();
  assert.equal(summary.flow_watch_rows, 1);
  assert.equal(summary.ema_entries_seen, 3);
  assert.deepEqual(summary.alertable, [
    { item: "subnet_ema_tao_flow", netuid: 3 },
  ]);
  const row = db
    .prepare(
      "SELECT netuid, is_set, ema_block, predates_capture FROM emission_flow_watch WHERE item = 'subnet_ema_tao_flow'",
    )
    .get() as Record<string, unknown>;
  assert.deepEqual(
    { ...row },
    {
      netuid: 3,
      is_set: 1,
      ema_block: 8_466_531,
      predates_capture: 0,
    },
  );
});

// --- degradation --------------------------------------------------------------

test("a read tier returning no rows envelope is treated as a first run", async () => {
  const recorded: unknown[] = [];
  const bare = {
    prepare(sql: string) {
      return {
        // D1 always envelopes rows in { results }; a degraded/foreign shape
        // must read as zero rows, not throw.
        async all() {
          return undefined;
        },
        bind(...values: unknown[]) {
          return { sql, values };
        },
      };
    },
    async batch(statements: unknown[]) {
      recorded.push(...statements);
      return statements;
    },
  };
  const res = await post(baseBody(), env({ METAGRAPH_HEALTH_DB: bare }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).gate_param_rows, 4);
  assert.equal(recorded.length, 10);
});

test("a D1 failure is contained as a 502, never an uncaught throw", async () => {
  const exploding = {
    prepare() {
      throw new Error("d1 down");
    },
    batch: async () => {},
  };
  const res = await post(baseBody(), env({ METAGRAPH_HEALTH_DB: exploding }));
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error.code, "emission_gate_sync_failed");
});
