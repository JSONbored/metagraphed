import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  currentNeuronsD1ReadFailureGeneration,
  readNeuron,
  readSubnetNeurons,
  readSubnetValidators,
} from "../src/neurons-d1-read.ts";
import { NEURON_INSERT_COLUMNS } from "../src/metagraph-neurons.ts";
import { handleRequest } from "../workers/api.ts";
import { mockEnv } from "./row-type.ts";
import type { Row } from "./row-type.ts";

function req(path: string) {
  return new Request(`https://api.metagraph.sh${path}`);
}

function neuronRow(netuid: number, uid: number, extra: Row = {}): Row {
  return {
    netuid,
    uid,
    hotkey: `5H${"a".repeat(46)}`,
    coldkey: `5C${"b".repeat(46)}`,
    active: 1,
    validator_permit: 1,
    rank: 1,
    trust: 0,
    validator_trust: 0.9,
    consensus: 0.4,
    incentive: 0.5,
    dividends: 0.1,
    emission_tao: 0.25,
    stake_tao: 12.5,
    registered_at_block: 8_000_000,
    is_immunity_period: 0,
    axon: "1.2.3.4:8091",
    block_number: 8_755_000,
    captured_at: 1_785_700_000,
    take: 0.18,
    ...extra,
  };
}

// Structural D1 fake: records SQL + bindings so tests can assert the query
// shape, not just the result a stub was told to return.
function dbStub(rows: Row[], opts: Row = {}) {
  const calls: { sql: string; params: unknown[] }[] = [];
  return {
    calls,
    db: {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            return {
              async all() {
                calls.push({ sql, params });
                if (opts.throws) throw new Error("d1 down");
                if (opts.bareArray) return rows;
                return { results: rows };
              },
            };
          },
        };
      },
    },
  };
}

describe("readSubnetNeurons", () => {
  test("returns the subnet's rows and binds the netuid", async () => {
    const { db, calls } = dbStub([neuronRow(1, 0), neuronRow(1, 1)]);
    const rows = await readSubnetNeurons(db, 1);
    assert.equal(rows.length, 2);
    assert.deepEqual(calls[0].params, [1]);
    assert.match(calls[0].sql, /FROM neurons WHERE netuid = \?/);
    assert.match(calls[0].sql, /ORDER BY uid ASC/);
  });

  // The read must stay pinned to the writer's contract: `SELECT *` would
  // surface any column the migration gained but the writer never sends.
  test("selects exactly NEURON_INSERT_COLUMNS, not *", async () => {
    const { db, calls } = dbStub([]);
    await readSubnetNeurons(db, 7);
    assert.doesNotMatch(calls[0].sql, /SELECT \*/);
    for (const column of NEURON_INSERT_COLUMNS) {
      assert.ok(
        calls[0].sql.includes(`"${column}"`),
        `column ${column} must be selected`,
      );
    }
  });

  test("accepts both the D1 { results } wrapper and a bare array", async () => {
    const wrapped = dbStub([neuronRow(1, 0)]);
    const bare = dbStub([neuronRow(1, 0)], { bareArray: true });
    assert.equal((await readSubnetNeurons(wrapped.db, 1)).length, 1);
    assert.equal((await readSubnetNeurons(bare.db, 1)).length, 1);
  });

  test("no binding is zero rows, not a throw", async () => {
    assert.deepEqual(await readSubnetNeurons(null, 1), []);
    assert.deepEqual(await readSubnetNeurons(undefined, 1), []);
  });

  // A result that is neither the { results } wrapper nor a bare array means
  // the binding is not what we think it is — zero rows, not a crash and not a
  // half-read.
  test("an unrecognised result shape is zero rows", async () => {
    const weird = {
      prepare: () => ({
        bind: () => ({ all: async () => ({ unexpected: true }) }),
      }),
    };
    assert.deepEqual(await readSubnetNeurons(weird, 1), []);
  });

  // The distinction the whole fallback contract rests on.
  test("a read failure degrades to zero rows AND bumps the generation", async () => {
    const before = currentNeuronsD1ReadFailureGeneration();
    const { db } = dbStub([], { throws: true });
    assert.deepEqual(await readSubnetNeurons(db, 1), []);
    assert.equal(currentNeuronsD1ReadFailureGeneration(), before + 1);
  });

  test("an empty-but-successful read does NOT bump the generation", async () => {
    const before = currentNeuronsD1ReadFailureGeneration();
    const { db } = dbStub([]);
    assert.deepEqual(await readSubnetNeurons(db, 1), []);
    assert.equal(
      currentNeuronsD1ReadFailureGeneration(),
      before,
      "an empty subnet is a real answer, not a failure",
    );
  });
});

describe("readSubnetValidators", () => {
  // buildSubnetValidators does NOT filter — it formats whatever it is handed —
  // so the permit filter has to live in the reader's SQL.
  test("filters on validator_permit in SQL", async () => {
    const { db, calls } = dbStub([neuronRow(1, 0)]);
    await readSubnetValidators(db, 1);
    assert.match(calls[0].sql, /validator_permit = 1/);
    assert.deepEqual(calls[0].params, [1]);
  });
});

describe("readNeuron", () => {
  test("returns the single row and binds both keys", async () => {
    const { db, calls } = dbStub([neuronRow(3, 9)]);
    const row = await readNeuron(db, 3, 9);
    assert.equal(row?.uid, 9);
    assert.deepEqual(calls[0].params, [3, 9]);
    assert.match(calls[0].sql, /netuid = \? AND uid = \?/);
    assert.match(calls[0].sql, /LIMIT 1/);
  });

  // buildNeuronDetail distinguishes "no such neuron" from a malformed one, so
  // an absent uid must arrive as null rather than undefined.
  test("an absent uid is null", async () => {
    const { db } = dbStub([]);
    assert.equal(await readNeuron(db, 3, 999), null);
  });

  test("a read failure is null, not a throw", async () => {
    const { db } = dbStub([], { throws: true });
    assert.equal(await readNeuron(db, 3, 9), null);
  });
});

describe("the neurons routes fall back to D1 when Postgres misses", () => {
  // METAGRAPH_NEURONS_SOURCE unset ⇒ tryPostgresTier returns null immediately,
  // which is exactly the post-shutdown state this change is for.
  function envWithD1(rows: Row[], opts: Row = {}) {
    const { db, calls } = dbStub(rows, opts);
    return {
      env: mockEnv({ METAGRAPH_HEALTH_DB: db }) as unknown as Env,
      calls,
    };
  }

  test("subnet metagraph serves D1 rows and stays cacheable", async () => {
    const { env } = envWithD1([neuronRow(1, 0), neuronRow(1, 1)]);
    const res = await handleRequest(req("/api/v1/subnets/1/metagraph"), env);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    assert.equal(((body.data as Row).neurons as unknown[]).length, 2);
    assert.equal(
      res.headers.get("x-metagraph-degraded"),
      null,
      "a D1-served payload is not degraded",
    );
  });

  test("?validator_permit=true filters the D1 leg", async () => {
    const { env } = envWithD1([
      neuronRow(1, 0, { validator_permit: 1 }),
      neuronRow(1, 1, { validator_permit: 0 }),
    ]);
    const res = await handleRequest(
      req("/api/v1/subnets/1/metagraph?validator_permit=true"),
      env,
    );
    const body = (await res.json()) as Row;
    assert.equal(((body.data as Row).neurons as unknown[]).length, 1);
  });

  test("neuron detail serves the D1 row", async () => {
    const { env } = envWithD1([neuronRow(1, 4)]);
    const res = await handleRequest(req("/api/v1/subnets/1/neurons/4"), env);
    const body = (await res.json()) as Row;
    assert.equal(((body.data as Row).neuron as Row)?.uid, 4);
  });

  test("subnet validators read through the permit-filtered query", async () => {
    const { env, calls } = envWithD1([neuronRow(1, 0)]);
    const res = await handleRequest(req("/api/v1/subnets/1/validators"), env);
    const body = (await res.json()) as Row;
    assert.equal(((body.data as Row).validators as unknown[]).length, 1);
    assert.match(
      calls[0].sql,
      /validator_permit = 1/,
      "the permit filter must be in SQL, not left to the builder",
    );
  });

  // The invariant that keeps a D1 blip from pinning zeros into the edge.
  test("a D1 read failure marks the response degraded", async () => {
    const { env } = envWithD1([], { throws: true });
    const res = await handleRequest(req("/api/v1/subnets/1/metagraph"), env);
    assert.equal(res.status, 200);
    assert.ok(
      res.headers.get("x-metagraph-degraded"),
      "an unanswered read must not be cached as fresh",
    );
  });

  // CSV is a separate return path in both handlers, and it has to carry the
  // same degraded marking as the JSON envelope — a CSV download built from an
  // unanswered read must not be cached as fresh either.
  test("metagraph CSV serves D1 rows and is not marked degraded", async () => {
    const { env } = envWithD1([neuronRow(1, 0), neuronRow(1, 1)]);
    const res = await handleRequest(
      req("/api/v1/subnets/1/metagraph?format=csv"),
      env,
    );
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.split("\n").length > 2, "header plus rows");
    assert.equal(res.headers.get("x-metagraph-degraded"), null);
  });

  test("metagraph CSV is marked degraded when the D1 read fails", async () => {
    const { env } = envWithD1([], { throws: true });
    const res = await handleRequest(
      req("/api/v1/subnets/1/metagraph?format=csv"),
      env,
    );
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("x-metagraph-degraded"));
  });

  test("validators CSV serves D1 rows and is not marked degraded", async () => {
    const { env } = envWithD1([neuronRow(1, 0)]);
    const res = await handleRequest(
      req("/api/v1/subnets/1/validators?format=csv"),
      env,
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-metagraph-degraded"), null);
  });

  test("validators CSV is marked degraded when the D1 read fails", async () => {
    const { env } = envWithD1([], { throws: true });
    const res = await handleRequest(
      req("/api/v1/subnets/1/validators?format=csv"),
      env,
    );
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("x-metagraph-degraded"));
  });

  test("validators JSON is marked degraded when the D1 read fails", async () => {
    const { env } = envWithD1([], { throws: true });
    const res = await handleRequest(req("/api/v1/subnets/1/validators"), env);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    assert.deepEqual((body.data as Row).validators, []);
    assert.ok(res.headers.get("x-metagraph-degraded"));
  });

  test("neuron detail is marked degraded when the D1 read fails", async () => {
    const { env } = envWithD1([], { throws: true });
    const res = await handleRequest(req("/api/v1/subnets/1/neurons/4"), env);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("x-metagraph-degraded"));
  });

  test("no D1 binding still serves the schema-stable empty, marked degraded", async () => {
    const env = mockEnv({ METAGRAPH_HEALTH_DB: undefined }) as unknown as Env;
    const res = await handleRequest(req("/api/v1/subnets/1/metagraph"), env);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    assert.deepEqual((body.data as Row).neurons, []);
    assert.ok(res.headers.get("x-metagraph-degraded"));
  });
});
