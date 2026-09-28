import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, test } from "vitest";
import { Miniflare } from "miniflare";
import { createD1Sql, createD1Store } from "../src/d1-store.ts";
import { writeNeuronDocuments } from "../src/neuron-documents.ts";
import { neuronSnapshotWrite } from "../src/neurons-neon-write.ts";
import {
  readNeuronDirectoryRows,
  readDirectoryNominatorCounts,
  readSubnetNeuronRows,
  readNeuronEconomicsRows,
} from "../src/neuron-snapshot-read.ts";
import type { PgSql } from "../src/pg-sql.ts";

const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('test')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
const stamp = 1790090000000;
const unexpectedSql = {
  unsafe() {
    throw new Error("Must not read the old store");
  },
} as unknown as PgSql;
beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  for (const file of [
    "0007_neuron_documents.sql",
    "0020_neuron_axon_projection.sql",
    "0030_neuron_axon_insert_projection.sql",
    "0016_archive_export_revisions.sql",
  ]) {
    for (const sql of readFileSync(
      new URL(`../migrations/d1/${file}`, import.meta.url),
      "utf8",
    ).split("-- statement-breakpoint"))
      if (sql.trim()) await db.prepare(sql).run();
  }
  for (const sql of readFileSync(
    new URL("../migrations/d1/0010_ledger_state.sql", import.meta.url),
    "utf8",
  ).split("-- statement-breakpoint"))
    if (sql.trim()) await db.prepare(sql).run();
  await db
    .prepare(
      "INSERT INTO validator_nominator_counts(hotkey,nominator_count,captured_at) VALUES ('5Changed',5,?),('5Unregistered',7,?)",
    )
    .bind(stamp, stamp + 2000)
    .run();
  const rows = [0, 7, 128].flatMap((netuid) =>
    Array.from({ length: 258 }, (_, uid) => ({
      netuid,
      uid,
      hotkey: uid === 4 ? null : `5${uid % 7}`,
      coldkey: uid % 2 ? "5Cold" : null,
      validator_permit: uid % 3 === 0,
      validator_trust: uid / 1000,
      emission_tao: uid / 1000000000,
      stake_tao: uid % 4 ? (uid % 5) + 0.000000001 : null,
      block_number: 9123456 + netuid,
      captured_at: stamp + netuid,
      take: uid % 2 ? 0.1 : null,
      axon: uid % 2 ? JSON.stringify({ ip: "1.2.3.4", port: 8080 }) : null,
      active: uid % 2 === 0,
      incentive: uid / 10000,
      dividends: uid % 3 ? 0.01 : null,
    })),
  );
  await writeNeuronDocuments(createD1Store(db), {
    ...neuronSnapshotWrite(rows, stamp + 1000),
    dailyRows: [],
    positionRows: [],
  });
  // Identity comes from the member index, not stale identifiers in a document.
  await db
    .prepare("UPDATE neurons_members SET hotkey='5Changed' WHERE uid=0")
    .run();
  // Orphan documents and mis-sharded members must not reintroduce registrations.
  await db.prepare("DELETE FROM neurons_members WHERE uid=8").run();
  await db.prepare("UPDATE neurons_members SET shard=99 WHERE uid=9").run();
});
afterAll(() => runtime.dispose());

test("economic neuron projections preserve every row while expanding documents once", async () => {
  const legacy = createD1Store(db);
  for (const netuid of [undefined, 0, 7, 128, 999]) {
    const expected = await readNeuronEconomicsRows(legacy, {}, netuid);
    const statements: string[] = [];
    const binding = {
      prepare(sql: string) {
        statements.push(sql);
        return db.prepare(sql);
      },
      batch: db.batch.bind(db),
    };
    const actual = await readNeuronEconomicsRows(
      legacy,
      { D1_STATE: binding, D1_STATE_TABLES: "neurons" },
      netuid,
    );
    assert.deepEqual(actual, expected);
    assert.equal(statements.length, 1);
    if (netuid !== 999) {
      assert(actual.some((row) => row.hotkey === null));
      assert(actual.some((row) => row.validator_permit === 0));
      assert(actual.some((row) => row.stake_tao === null));
      assert(actual.some((row) => row.dividends === 0.01));
      assert(actual.some((row) => row.hotkey === "5Changed"));
    }
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${statements[0]}`);
    const explained = await (
      netuid === undefined ? plan : plan.bind(netuid)
    ).all<{ detail: string }>();
    const details = explained.results.map((row) => row.detail);
    assert(
      details.findIndex((x) => /(?:SCAN|SEARCH) d\b/.test(x)) <
        details.findIndex((x) => /SCAN j\b/.test(x)),
    );
    assert(
      details.findIndex((x) => /SCAN j\b/.test(x)) <
        details.findIndex((x) => /SEARCH m\b/.test(x)),
    );
    assert(!details.some((x) => /CORRELATED/.test(x)));
  }
});

test("packed economics retain SQLite boolean and structured-value semantics", async () => {
  const original = await db
    .prepare(
      "SELECT json(payload) AS payload FROM neurons_documents WHERE netuid=7 AND day='' AND shard=0",
    )
    .first<{ payload: string }>();
  assert(original);
  try {
    await db
      .prepare(
        `UPDATE neurons_documents SET payload=jsonb_set(payload,
      '$."0".active',json('true'),'$."1".active',json('false'),
      '$."0".take',json('{"nested":true}'),'$."1".take',json('[1,null]'))
      WHERE netuid=7 AND day='' AND shard=0`,
      )
      .run();
    const store = createD1Store(db);
    const expected = await readNeuronEconomicsRows(store, {}, 7);
    const actual = await readNeuronEconomicsRows(
      store,
      { D1_STATE: db, D1_STATE_TABLES: "neurons" },
      7,
    );
    assert.deepEqual(actual, expected);
    assert.equal(actual[0].active, 1);
    assert.equal(actual[1].active, 0);
    assert.equal(actual[0].take, '{"nested":true}');
    assert.equal(actual[1].take, "[1,null]");
  } finally {
    await db
      .prepare(
        "UPDATE neurons_documents SET payload=jsonb(?) WHERE netuid=7 AND day='' AND shard=0",
      )
      .bind(original.payload)
      .run();
  }
});

test("tracked neuron writes invalidate a reused full economics snapshot atomically", async () => {
  const statements: string[] = [];
  const binding = {
    prepare(text: string) {
      statements.push(text);
      return db.prepare(text);
    },
    batch: db.batch.bind(db),
  };
  const env = {
    D1_STATE: binding,
    D1_STATE_TABLES: "neurons",
    D1_EXPORT_REVISIONS: "enabled",
  };
  const store = createD1Store(db, ["neurons"]);
  const clear = () =>
    store.transaction([
      { text: "DELETE FROM neurons_members WHERE netuid=202" },
      { text: "DELETE FROM neurons_documents WHERE netuid=202" },
    ]);
  await clear();
  try {
    const first = await readNeuronEconomicsRows(store, env);
    const again = await readNeuronEconomicsRows(store, env);
    assert.deepEqual(again, first);
    assert.equal(
      statements.filter((sql) => sql.includes("FROM neurons_documents")).length,
      1,
    );
    await writeNeuronDocuments(store, {
      ...neuronSnapshotWrite(
        [
          {
            netuid: 202,
            uid: 0,
            hotkey: "5New",
            stake_tao: 123,
            captured_at: stamp + 9000,
          },
        ],
        stamp + 10000,
      ),
      dailyRows: [],
      positionRows: [],
    });
    const changed = await readNeuronEconomicsRows(store, env);
    assert.equal(changed.length, first.length + 1);
    assert.equal(changed.at(-1)!.stake_tao, 123);
    assert.deepEqual(changed, await readNeuronEconomicsRows(store, {}));
    assert.equal(
      statements.filter((sql) => sql.includes("FROM neurons_documents")).length,
      2,
    );
  } finally {
    await clear();
  }
});

test.each([false, true])(
  "native snapshot is exactly the indexed-view result, validatorsOnly=%s",
  async (validatorsOnly) => {
    const portable = createD1Sql(createD1Store(db));
    const expected = await readNeuronDirectoryRows(
      portable,
      {},
      validatorsOnly,
    );
    const statements: string[] = [];
    const binding = {
      prepare(sql: string) {
        statements.push(sql);
        return db.prepare(sql);
      },
      batch: db.batch.bind(db),
    };
    const actual = await readNeuronDirectoryRows(
      unexpectedSql,
      { D1_STATE: binding, D1_STATE_TABLES: "neurons" },
      validatorsOnly,
    );
    assert.deepEqual(actual, expected);
    assert.ok(actual.length > 200);
    assert.ok(actual.some((row) => row.hotkey === "5Changed"));
    assert.ok(
      actual.every((row) => row.uid !== 4 && row.uid !== 8 && row.uid !== 9),
    );
    assert.equal(statements.length, 1);
    const plan = (
      await db
        .prepare(`EXPLAIN QUERY PLAN ${statements[0]}`)
        .all<{ detail: string }>()
    ).results.map((row) => row.detail);
    assert.match(plan[0], /^SCAN d/);
    assert.match(plan[1], /^SCAN j VIRTUAL TABLE/);
    assert.match(
      plan[2],
      /^SEARCH m USING PRIMARY KEY \(netuid=\? AND uid=\?\)/,
    );
    assert.equal(plan.filter((step) => step.includes("SCAN d")).length, 1);
  },
);

test("the default reads all accounts and absent selected storage cannot fall back", async () => {
  const environment = { D1_STATE: db, D1_STATE_TABLES: "neurons" };
  assert.deepEqual(
    await readNeuronDirectoryRows(unexpectedSql, environment),
    await readNeuronDirectoryRows(unexpectedSql, environment, false),
  );
  await assert.rejects(
    readNeuronDirectoryRows(unexpectedSql, { D1_STATE_TABLES: "neurons" }),
    /Selected D1 store is unbound/,
  );
  await assert.rejects(
    readNeuronDirectoryRows(unexpectedSql, {}),
    /Must not read the old store/,
  );
});

test("nominator enrichment preserves distinct permitted keys, nulls and the whole-scan stamp without rescanning neurons", async () => {
  const environment = {
    D1_STATE: db,
    D1_STATE_TABLES: "neurons,validator_nominator_counts",
  };
  const memberships = await readNeuronDirectoryRows(
    unexpectedSql,
    environment,
    true,
  );
  const keys = memberships.map((row) => row.hotkey);
  assert.ok(keys.length > new Set(keys).size);
  const expected = await readDirectoryNominatorCounts(
    createD1Sql(createD1Store(db)),
    {},
    [],
  );
  const statements: string[] = [];
  const actual = await readDirectoryNominatorCounts(
    unexpectedSql,
    {
      ...environment,
      D1_STATE: {
        prepare(sql: string) {
          statements.push(sql);
          return db.prepare(sql);
        },
        batch: db.batch.bind(db),
      },
    },
    keys,
  );
  const sorted = (rows: { hotkey: string }[]) =>
    rows.sort((a, b) => a.hotkey.localeCompare(b.hotkey));
  assert.deepEqual(sorted(actual), sorted(expected));
  assert.ok(actual.some((r) => r.nominator_count === null));
  assert.ok(actual.some((r) => r.nominator_count === 5));
  assert.ok(actual.every((r) => r.scan_at === stamp + 2000));
  assert.ok(actual.every((r) => r.hotkey !== "5Unregistered"));
  assert.equal(statements.length, 1);
  assert.doesNotMatch(statements[0], /FROM neurons/);
  assert.deepEqual(
    await readDirectoryNominatorCounts(unexpectedSql, environment, []),
    [],
  );
  await db.prepare("DELETE FROM validator_nominator_counts").run();
  assert.ok(
    (
      await readDirectoryNominatorCounts(unexpectedSql, environment, keys)
    ).every((r) => r.nominator_count === null && r.scan_at === null),
  );
  await assert.rejects(
    readDirectoryNominatorCounts(
      unexpectedSql,
      { D1_STATE_TABLES: environment.D1_STATE_TABLES },
      keys,
    ),
    /Selected D1 store is unbound/,
  );
});

test.each([false, true])(
  "subnet lists preserve every column, membership and ordering, validatorsOnly=%s",
  async (validatorsOnly) => {
    const portable = createD1Sql(createD1Store(db));
    for (const netuid of [0, 7, 128, 999]) {
      const statements: string[] = [];
      const binding = {
        prepare(sql: string) {
          statements.push(sql);
          return db.prepare(sql);
        },
        batch: db.batch.bind(db),
      };
      const expected = await readSubnetNeuronRows(
        portable,
        {},
        netuid,
        validatorsOnly,
      );
      const actual = await readSubnetNeuronRows(
        unexpectedSql,
        { D1_STATE: binding, D1_STATE_TABLES: "neurons" },
        netuid,
        validatorsOnly,
      );
      assert.deepEqual(actual, expected);
      assert.equal(statements.length, 1);
      if (netuid === 999) assert.equal(actual.length, 0);
      else {
        assert.ok(actual.length > 80);
        assert.equal(actual.find((row) => row.uid === 0)?.hotkey, "5Changed");
        assert.ok(actual.every((row) => row.uid !== 8 && row.uid !== 9));
        if (!validatorsOnly)
          assert.equal(actual.find((row) => row.uid === 4)?.hotkey, null);
      }
      const plan = (
        await db
          .prepare(`EXPLAIN QUERY PLAN ${statements[0]}`)
          .bind(netuid, netuid)
          .all<{ detail: string }>()
      ).results.map((row) => row.detail);
      assert.ok(
        plan.some((step) =>
          /SEARCH neurons_documents USING PRIMARY KEY/.test(step),
        ),
      );
      assert.ok(
        plan.some((step) =>
          /SEARCH neurons_members USING PRIMARY KEY/.test(step),
        ),
      );
      assert.ok(plan.every((step) => !/VIRTUAL TABLE|TEMP B-TREE/.test(step)));
    }
  },
);

test("subnet defaults preserve all rows and missing selected storage fails closed", async () => {
  const env = { D1_STATE: db, D1_STATE_TABLES: "neurons" };
  assert.deepEqual(
    await readSubnetNeuronRows(unexpectedSql, env, 7),
    await readSubnetNeuronRows(unexpectedSql, env, 7, false),
  );
  await assert.rejects(
    readSubnetNeuronRows(unexpectedSql, { D1_STATE_TABLES: "neurons" }, 7),
    /Selected D1 store is unbound/,
  );
});

test("subnet reads preserve missing metrics and reject malformed stored entries", async () => {
  const env = { D1_STATE: db, D1_STATE_TABLES: "neurons" };
  await db
    .prepare(
      "UPDATE neurons_documents SET payload=jsonb_remove(payload,'$.\"5\"') WHERE netuid=7 AND shard=0",
    )
    .run();
  const rows = await readSubnetNeuronRows(unexpectedSql, env, 7);
  assert.deepEqual(
    rows,
    await readSubnetNeuronRows(createD1Sql(createD1Store(db)), {}, 7),
  );
  assert.equal(rows.find((row) => row.uid === 5)?.captured_at, null);
  await db
    .prepare(
      "UPDATE neurons_documents SET payload=jsonb_set(payload,'$.\"5\"',42) WHERE netuid=7 AND shard=0",
    )
    .run();
  await assert.rejects(readSubnetNeuronRows(unexpectedSql, env, 7));
});

test("an empty native snapshot is empty for both directories", async () => {
  const emptyDb = await runtime.getD1Database("DB");
  await emptyDb.prepare("DELETE FROM neurons_members").run();
  for (const validatorsOnly of [false, true]) {
    assert.deepEqual(
      await readNeuronDirectoryRows(
        unexpectedSql,
        { D1_STATE: emptyDb, D1_STATE_TABLES: "neurons" },
        validatorsOnly,
      ),
      [],
    );
  }
});
