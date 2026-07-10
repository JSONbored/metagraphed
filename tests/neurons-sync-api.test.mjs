// Unit tests for the neurons-sync Worker (workers/neurons-sync-api.mjs, #4771).
// postgres.js is mocked so the auth/validation/upsert routing is tested with no
// real DB — the live Hyperdrive path is validated separately. The mock supports
// BOTH postgres.js call shapes this Worker uses: a tagged-template query
// (`sql\`...${value}...\``) and the sql(rows, ...columns) bulk-insert helper
// (`${sql(chunk, ...cols)}` spliced into a tagged template) — the registry-sync
// Worker's existing mock only needed the former.
import { beforeEach, expect, test, vi } from "vitest";

const sqlCalls = vi.hoisted(() => []);
const failure = vi.hoisted(() => ({ error: null }));
const pruneResult = vi.hoisted(() => ({ rows: [] }));

vi.mock("postgres", () => ({
  default: () => {
    function sql(first, ...rest) {
      // Tagged-template invocation: the first arg is a real template-strings
      // array (has `.raw`). Plain arrays (the bulk-insert helper call) don't.
      if (
        Array.isArray(first) &&
        Object.prototype.hasOwnProperty.call(first, "raw")
      ) {
        const strings = first;
        const values = rest;
        let text = strings[0];
        const boundValues = [];
        for (let i = 0; i < values.length; i += 1) {
          const v = values[i];
          if (v && v.__bulkInsert) {
            const cols = v.columns;
            text += `(${cols.join(",")}) VALUES ${v.rows
              .map(() => `(${cols.map(() => "?").join(",")})`)
              .join(",")}`;
            for (const row of v.rows) {
              for (const col of cols) boundValues.push(row[col] ?? null);
            }
          } else {
            text += "?";
            boundValues.push(v);
          }
          text += strings[i + 1];
        }
        sqlCalls.push({ text, values: boundValues });
        if (failure.error && /INSERT INTO neurons\b/.test(text)) {
          return Promise.reject(failure.error);
        }
        if (/DELETE FROM neurons/.test(text)) {
          return Promise.resolve(pruneResult.rows);
        }
        return Promise.resolve([]);
      }
      // sql(rowsArray, ...columns) bulk-insert helper.
      if (Array.isArray(first)) {
        const columns = rest.length ? rest : Object.keys(first[0] || {});
        return { __bulkInsert: true, rows: first, columns };
      }
      throw new Error(`unexpected sql() call shape: ${typeof first}`);
    }
    sql.begin = (cb) => cb(sql);
    return sql;
  },
}));

const { default: worker } = await import("../workers/neurons-sync-api.mjs");

const SECRET = "test-neurons-sync-secret";

function post(body, { secret, method = "POST", raw } = {}) {
  const headers = { "content-type": "application/json" };
  if (secret) headers["x-neurons-sync-token"] = secret;
  const init = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = raw !== undefined ? raw : JSON.stringify(body ?? []);
  }
  return new Request("https://neurons-sync.internal/", init);
}

function baseEnv(overrides = {}) {
  return {
    NEURONS_SYNC_SECRET: SECRET,
    HYPERDRIVE: { connectionString: "postgres://mock" },
    ...overrides,
  };
}

function neuronRow(overrides = {}) {
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

beforeEach(() => {
  sqlCalls.length = 0;
  pruneResult.rows = [];
  failure.error = null;
});

test("rejects non-POST (405)", async () => {
  const res = await worker.fetch(post(null, { method: "GET" }), baseEnv(), {});
  expect(res.status).toBe(405);
});

test("is disabled (503) when NEURONS_SYNC_SECRET is not configured", async () => {
  const res = await worker.fetch(
    post([neuronRow()], { secret: SECRET }),
    { HYPERDRIVE: { connectionString: "postgres://mock" } },
    {},
  );
  expect(res.status).toBe(503);
});

test("rejects a missing or wrong token (401)", async () => {
  const env = baseEnv();
  const wrong = await worker.fetch(
    post([neuronRow()], { secret: "wrong" }),
    env,
    {},
  );
  expect(wrong.status).toBe(401);
  const missing = await worker.fetch(post([neuronRow()]), env, {});
  expect(missing.status).toBe(401);
});

test("returns 503 when the HYPERDRIVE binding is unavailable", async () => {
  const res = await worker.fetch(
    post([neuronRow()], { secret: SECRET }),
    { NEURONS_SYNC_SECRET: SECRET },
    {},
  );
  expect(res.status).toBe(503);
});

test("rejects a body over the byte cap (413)", async () => {
  const res = await worker.fetch(
    post(null, { secret: SECRET, raw: "[" + "1".repeat(33_000_000) + "]" }),
    baseEnv(),
    {},
  );
  expect(res.status).toBe(413);
});

test("rejects malformed JSON (400)", async () => {
  const res = await worker.fetch(
    post(null, { secret: SECRET, raw: "{not json" }),
    baseEnv(),
    {},
  );
  expect(res.status).toBe(400);
});

test("rejects a body that isn't an array or {rows:[...]} (400)", async () => {
  const res = await worker.fetch(
    post({ not: "an array" }, { secret: SECRET }),
    baseEnv(),
    {},
  );
  expect(res.status).toBe(400);
});

test("accepts the {rows:[...]} wrapped form, not just a bare array", async () => {
  const res = await worker.fetch(
    post({ rows: [neuronRow()] }, { secret: SECRET }),
    baseEnv(),
    {},
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.neurons_written).toBe(1);
});

test("rejects more than the row cap (413)", async () => {
  const many = Array.from({ length: 50_001 }, (_, i) =>
    neuronRow({ uid: i % 65_536 }),
  );
  const res = await worker.fetch(post(many, { secret: SECRET }), baseEnv(), {});
  expect(res.status).toBe(413);
});

test("rejects rows with an out-of-range netuid/uid (400)", async () => {
  const netuid = await worker.fetch(
    post([neuronRow({ netuid: 70_000 })], { secret: SECRET }),
    baseEnv(),
    {},
  );
  expect(netuid.status).toBe(400);
  const uid = await worker.fetch(
    post([neuronRow({ uid: 70_000 })], { secret: SECRET }),
    baseEnv(),
    {},
  );
  expect(uid.status).toBe(400);
});

test("rejects a non-object row (400)", async () => {
  const res = await worker.fetch(
    post(["not-an-object"], { secret: SECRET }),
    baseEnv(),
    {},
  );
  expect(res.status).toBe(400);
});

test("rejects a row with a string field over the byte cap (400)", async () => {
  const res = await worker.fetch(
    post([neuronRow({ hotkey: "5".repeat(600) })], { secret: SECRET }),
    baseEnv(),
    {},
  );
  expect(res.status).toBe(400);
});

test("rejects a row with a numeric field that overflows to Infinity (400)", async () => {
  // JSON.stringify(NaN) silently serializes to `null` (not a reproduction of
  // this check), but a raw oversized literal like 1e400 is syntactically
  // valid JSON that JSON.parse genuinely parses to Infinity -- a real,
  // reachable way a non-finite number arrives here.
  const { stake_tao: _stakeTao, ...rest } = neuronRow();
  const raw = JSON.stringify([rest]).replace(/}\]$/, `,"stake_tao":1e400}]`);
  const res = await worker.fetch(
    post(null, { secret: SECRET, raw }),
    baseEnv(),
    {},
  );
  expect(res.status).toBe(400);
});

test("rejects a row carrying a nested object/array value instead of a scalar (400)", async () => {
  const res = await worker.fetch(
    post([neuronRow({ hotkey: ["not", "a", "scalar"] })], { secret: SECRET }),
    baseEnv(),
    {},
  );
  expect(res.status).toBe(400);
});

test("rejects a row carrying an unknown column (400)", async () => {
  const res = await worker.fetch(
    post([neuronRow({ unexpected_field: "nope" })], { secret: SECRET }),
    baseEnv(),
    {},
  );
  expect(res.status).toBe(400);
});

test("rejects a row missing a valid captured_at (400)", async () => {
  const res = await worker.fetch(
    post([neuronRow({ captured_at: 0 })], { secret: SECRET }),
    baseEnv(),
    {},
  );
  expect(res.status).toBe(400);
});

test("rejects an empty array (400)", async () => {
  const res = await worker.fetch(post([], { secret: SECRET }), baseEnv(), {});
  expect(res.status).toBe(400);
});

test("defaults a missing optional column (e.g. axon) to null rather than undefined", async () => {
  const { axon: _axon, ...withoutAxon } = neuronRow();
  const res = await worker.fetch(
    post([withoutAxon], { secret: SECRET }),
    baseEnv(),
    {},
  );
  expect(res.status).toBe(200);
  const neuronsInsert = sqlCalls.find((c) =>
    /INSERT INTO neurons\b/.test(c.text),
  );
  expect(neuronsInsert.values).toContain(null);
});

test("upserts neurons + neuron_daily and reports written counts", async () => {
  const res = await worker.fetch(
    post([neuronRow(), neuronRow({ uid: 4, netuid: 9 })], { secret: SECRET }),
    baseEnv(),
    {},
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({
    ok: true,
    neurons_written: 2,
    neuron_daily_written: 2,
    netuids_covered: 2,
  });
  const text = sqlCalls.map((c) => c.text).join("\n");
  expect(text).toMatch(/INSERT INTO neurons\b/);
  expect(text).toMatch(/INSERT INTO neuron_daily/);
  expect(text).toMatch(/DELETE FROM neurons/);
});

test("coerces 0/1 active/validator_permit/is_immunity_period to real booleans in the bound values", async () => {
  await worker.fetch(
    post(
      [neuronRow({ active: 1, validator_permit: 0, is_immunity_period: 1 })],
      {
        secret: SECRET,
      },
    ),
    baseEnv(),
    {},
  );
  const neuronsInsert = sqlCalls.find((c) =>
    /INSERT INTO neurons\b/.test(c.text),
  );
  expect(neuronsInsert.values).toContain(true); // active / is_immunity_period
  expect(neuronsInsert.values).toContain(false); // validator_permit
});

test("derives snapshot_date from captured_at for the neuron_daily row", async () => {
  await worker.fetch(
    post([neuronRow({ captured_at: Date.parse("2026-06-20T12:00:00Z") })], {
      secret: SECRET,
    }),
    baseEnv(),
    {},
  );
  const dailyInsert = sqlCalls.find((c) =>
    /INSERT INTO neuron_daily/.test(c.text),
  );
  expect(dailyInsert.values).toContain("2026-06-20");
});

test("scopes the deregistered-UID prune to only the netuids present in this batch", async () => {
  await worker.fetch(
    post([neuronRow({ netuid: 8 }), neuronRow({ netuid: 9, uid: 1 })], {
      secret: SECRET,
    }),
    baseEnv(),
    {},
  );
  const pruneCall = sqlCalls.find((c) => /DELETE FROM neurons/.test(c.text));
  expect(pruneCall.values[0]).toEqual(expect.arrayContaining([8, 9]));
  expect(pruneCall.values[0]).toHaveLength(2);
});

test("reports deregistered_pruned from the DELETE's returned row count", async () => {
  pruneResult.rows = [{ netuid: 8 }, { netuid: 8 }];
  const res = await worker.fetch(
    post([neuronRow()], { secret: SECRET }),
    baseEnv(),
    {},
  );
  const body = await res.json();
  expect(body.deregistered_pruned).toBe(2);
});

test("maps a DB failure to a clean 502 instead of throwing", async () => {
  failure.error = new Error("connection reset");
  const res = await worker.fetch(
    post([neuronRow()], { secret: SECRET }),
    baseEnv(),
    {},
  );
  expect(res.status).toBe(502);
  expect((await res.json()).error).toBe("write failed");
});
