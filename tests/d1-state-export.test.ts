import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, afterAll, test } from "vitest";
import { Miniflare } from "miniflare";
import { handleD1StateExport } from "../src/d1-state-export.ts";
import { D1_EXPORT_TABLES } from "../src/d1-export-tables.ts";
import { D1_EXPORT_COLUMNS } from "../src/d1-export-columns.ts";
import { selectedD1Store, createD1Store } from "../src/d1-store.ts";
import { writeNeuronDocuments } from "../src/neuron-documents.ts";
import { neuronSnapshotWrite } from "../src/neurons-neon-write.ts";
import dataWorker from "../workers/data-api.ts";
import apiWorker from "../workers/api.ts";
import { apiEnv, dataApiEnv } from "./helpers/worker-env.ts";
const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('test')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
const tables = [...Object.keys(D1_EXPORT_TABLES), "neurons_passes"].join(",");
const env = () => ({
  D1_STATE: db,
  D1_STATE_TABLES: tables,
  D1_EXPORT_REVISIONS: "enabled",
  STATE_EXPORT_SECRET: "secret",
});
const req = (body: unknown, method = "POST", token = "secret") =>
  new Request("https://example.com/api/v1/internal/state-export", {
    method,
    headers: { "x-state-export-token": token },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
async function get(body: unknown, overrides: Record<string, unknown> = {}) {
  const response = await handleD1StateExport(req(body), {
    ...env(),
    ...overrides,
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get("cache-control"), "no-store");
  return response.json<{
    columns: { name: string; type: string }[];
    rows: unknown[][];
    days: { day: string; rows: number }[];
    revision: number;
    day_revisions?: boolean;
    next_cursor: (string | number)[] | null;
  }>();
}
beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  const root = new URL("../migrations/d1/", import.meta.url);
  for (const file of readdirSync(root)
    .filter((f) => f.endsWith(".sql"))
    .sort())
    for (const sql of readFileSync(new URL(file, root), "utf8").split(
      "-- statement-breakpoint",
    ))
      if (sql.trim()) await db.prepare(sql).run();
});
afterAll(async () => runtime.dispose());

test("all 34 archive schemas and empty exports use native D1 with logical types", async () => {
  assert.equal(Object.keys(D1_EXPORT_TABLES).length, 34);
  assert.deepEqual(
    Object.keys(D1_EXPORT_COLUMNS).sort(),
    Object.keys(D1_EXPORT_TABLES).sort(),
  );
  for (const table of Object.keys(D1_EXPORT_TABLES)) {
    const schema = await get({ table, kind: "schema" });
    assert.ok(schema.columns.length > 0);
    const names = schema.columns.map((c) => c.name);
    assert.deepEqual(
      [...names].sort(),
      D1_EXPORT_COLUMNS[table]!.split(" ").sort(),
    );
    assert.ok(names.every((name: string) => !name.startsWith("_")));
    const rows = await get({ table, kind: "rows", columns: names });
    assert.deepEqual(rows.rows, []);
    assert.equal(rows.next_cursor, null);
    assert.equal(rows.revision, 0);
  }
  const types = async (table: string) =>
    (await get({ table, kind: "schema" })).columns;
  assert.ok(
    (await types("compute_declarations")).some(
      (c) => c.name === "miner" && c.type === "jsonb",
    ),
  );
  assert.ok(
    (await types("nominator_positions")).some(
      (c) => c.name === "shares" && c.type === "numeric",
    ),
  );
  assert.ok(
    (await types("self_health_daily")).some(
      (c) => c.name === "day" && c.type === "date",
    ),
  );
  assert.ok(
    (await types("subnet_hyperparams")).some(
      (c) => c.name === "weights_version" && c.type === "int8",
    ),
  );
});

test("lifecycle export excludes invalidated derived events without disclosing correction metadata or deleting originals", async () => {
  const at = 1790090000000;
  await db.batch([
    db
      .prepare(
        "INSERT INTO subnet_lifecycle(id,netuid,event,observed_at) VALUES(900,1,'registered',?)",
      )
      .bind(at),
    db
      .prepare(
        "INSERT INTO subnet_lifecycle(id,netuid,event,observed_at,_invalidated_at,_invalidation_reason) VALUES(901,1,'deregistered',?,?,?)",
      )
      .bind(at + 1, at + 2, "incomplete capture"),
  ]);
  try {
    const schema = await get({ table: "subnet_lifecycle", kind: "schema" });
    assert.ok(schema.columns.every((c) => !c.name.startsWith("_")));
    const exported = await get({
      table: "subnet_lifecycle",
      kind: "rows",
      columns: ["id", "event"],
      watermark: ["id"],
      since: [899],
    });
    assert.deepEqual(exported.rows, [[900, "registered"]]);
    assert.equal(
      await db
        .prepare("SELECT count(*) n FROM subnet_lifecycle WHERE id>=900")
        .first("n"),
      2,
    );
  } finally {
    await db
      .prepare("DELETE FROM subnet_lifecycle WHERE id IN (900,901)")
      .run();
  }
});

test("document-backed exports declare numeric contracts even when JSON rows mix strings and numbers", async () => {
  for (const table of ["neurons", "neuron_daily", "account_position_daily"]) {
    const { columns } = await get({ table, kind: "schema" });
    const type = (name: string) => columns.find((c) => c.name === name)?.type;
    for (const name of ["uid", "netuid", "captured_at"])
      assert.equal(type(name), "int8");
    for (const name of [
      "rank",
      "trust",
      "incentive",
      "dividends",
      "stake_tao",
      "emission_tao",
    ])
      assert.equal(type(name), "float8");
    assert.equal(type("coldkey"), "text");
    assert.equal(type("active"), "bool");
  }
  await writeNeuronDocuments(createD1Store(db), {
    rows: [],
    dailyRows: [],
    positionRows: ["mixed-a", "mixed-b"].map((account, index) => ({
      account,
      netuid: 1,
      uid: index,
      snapshot_date: "2026-09-21",
      captured_at: 1790090000000,
      stake_tao: index ? 0 : "12.5",
      emission_tao: index ? "0.25" : 0,
    })),
  });
  try {
    const result = await get({
      table: "account_position_daily",
      kind: "rows",
      day: "2026-09-21",
      columns: ["account", "uid", "stake_tao", "emission_tao"],
    });
    assert.deepEqual(result.rows, [
      ["mixed-a", 0, "12.5", 0],
      ["mixed-b", 1, 0, "0.25"],
    ]);
  } finally {
    await db.batch([
      db.prepare(
        "DELETE FROM account_position_daily_members WHERE account IN ('mixed-a','mixed-b')",
      ),
      db.prepare(
        "DELETE FROM account_position_daily_documents WHERE netuid=1 AND day='2026-09-21'",
      ),
    ]);
  }
});

test("wide neuron export pages preserve view values, membership, cursors and revisions", async () => {
  const fields = D1_EXPORT_COLUMNS.neurons!.split(" ");
  const documents = new Map<string, Record<string, unknown>>();
  const members: (number | string | null)[][] = [];
  for (let index = 0; index < 2065; index++) {
    const netuid = index < 2055 ? 32000 : 32001;
    const uid = index < 2055 ? index : index - 2055;
    const shard = Math.floor(uid / 256);
    const key = `${netuid}/${shard}`;
    const payload = documents.get(key) ?? {};
    payload[uid] = {
      hotkey: "unaccepted-payload-identity",
      active: true,
      validator_permit: false,
      rank: uid % 2 ? "0.125" : 0.25,
      trust: null,
      validator_trust: 0,
      consensus: 0.75,
      incentive: 0.5,
      dividends: 0.25,
      emission_tao: "1.25",
      stake_tao: 2,
      registered_at_block: 9000000,
      is_immunity_period: true,
      axon: uid % 2 ? "[2001:db8::1]:80" : { ip: "1.2.3.4", port: 80 },
      block_number: "9175000",
      captured_at: 1790090000000,
      take: 0,
    };
    documents.set(key, payload);
    members.push([netuid, uid, uid % 2 ? `h${uid}` : null, `c${uid}`, shard]);
  }
  const first = documents.get("32000/0")!;
  delete first[0];
  for (const [index, value] of [null, "plain", 42, true, [], {}].entries())
    first[index + 1] = value;
  members[8]![4] = 1; // A member displaced from its old metrics stays null.
  first[9999] = { active: true }; // A metric without membership is not a row.
  members.push([32002, 0, "missing-document", null, 0]);
  try {
    await db.batch([
      ...[...documents].map(([key, payload]) => {
        const [netuid, shard] = key.split("/").map(Number);
        return db
          .prepare(
            "INSERT INTO neurons_documents VALUES(?,'',?,1790090000000,jsonb(?))",
          )
          .bind(netuid, shard, JSON.stringify(payload));
      }),
      db
        .prepare(
          "INSERT INTO neurons_members SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]'),json_extract(value,'$[3]'),json_extract(value,'$[4]') FROM json_each(?)",
        )
        .bind(JSON.stringify(members)),
    ]);
    const baseline = (
      await db
        .prepare(
          `SELECT ${fields.map((field) => `"${field}"`).join(",")} FROM neurons ORDER BY netuid,uid`,
        )
        .all<Record<string, unknown>>()
    ).results;
    assert.equal(baseline.length, 2065);
    const firstPage = await get({
      table: "neurons",
      kind: "rows",
      columns: fields,
    });
    assert.equal(firstPage.rows.length, 2000);
    assert.deepEqual(firstPage.next_cursor, [32000, 1999]);
    const secondPage = await get({
      table: "neurons",
      kind: "rows",
      columns: fields,
      cursor: firstPage.next_cursor,
      revision: firstPage.revision,
    });
    assert.equal(secondPage.next_cursor, null);
    assert.deepEqual(
      [...firstPage.rows, ...secondPage.rows],
      baseline.map((row) => fields.map((field) => row[field])),
    );
    const narrow = await get({
      table: "neurons",
      kind: "rows",
      columns: ["hotkey", "rank"],
      cursor: [32001, 8],
      revision: firstPage.revision,
    });
    assert.deepEqual(narrow.rows, [["h9", "0.125"]]);
    assert.equal(narrow.next_cursor, null);
    await db
      .prepare(
        "INSERT INTO archive_export_revisions(table_name,revision) VALUES('neurons',?) ON CONFLICT(table_name) DO UPDATE SET revision=excluded.revision",
      )
      .bind(firstPage.revision + 1)
      .run();
    assert.equal(
      (
        await handleD1StateExport(
          req({
            table: "neurons",
            kind: "rows",
            columns: fields,
            cursor: firstPage.next_cursor,
            revision: firstPage.revision,
          }),
          env(),
        )
      ).status,
      409,
    );
  } finally {
    await db.batch([
      db.prepare("DELETE FROM neurons_members WHERE netuid>=32000"),
      db.prepare("DELETE FROM neurons_documents WHERE netuid>=32000"),
    ]);
  }
});

test("a later storage migration cannot authorize an unapproved archive column", async () => {
  await db
    .prepare("ALTER TABLE account_balances ADD COLUMN internal_credential TEXT")
    .run();
  try {
    for (const input of [
      { table: "account_balances", kind: "schema" },
      {
        table: "account_balances",
        kind: "rows",
        columns: ["internal_credential"],
      },
      { table: "account_balances", kind: "rows", columns: ["ss58"] },
    ]) {
      const response = await handleD1StateExport(req(input), env());
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        error: "export schema requires approval",
      });
    }
  } finally {
    await db
      .prepare("ALTER TABLE account_balances DROP COLUMN internal_credential")
      .run();
  }
  await db
    .prepare("ALTER TABLE account_balances ADD COLUMN _private_state TEXT")
    .run();
  try {
    const schema = await get({ table: "account_balances", kind: "schema" });
    assert.ok(
      !schema.columns.some((column) => column.name === "_private_state"),
    );
    assert.equal(
      (
        await handleD1StateExport(
          req({
            table: "account_balances",
            kind: "rows",
            columns: ["_private_state"],
          }),
          env(),
        )
      ).status,
      400,
    );
  } finally {
    await db
      .prepare("ALTER TABLE account_balances DROP COLUMN _private_state")
      .run();
  }
});

test("family revisions commit atomically once per transaction and preserve return counts", async () => {
  const store = selectedD1Store(env(), [
    "account_balances",
    "account_balances",
  ]);
  assert.ok(store);
  const insert = (id: string) => ({
    text: "INSERT INTO account_balances(ss58,free_tao,reserved_tao,captured_at) VALUES(?,?,?,?)",
    values: [id, 1, 2, 1790000000000],
  });
  assert.deepEqual(await store.transaction([]), []);
  assert.deepEqual(
    await store.transaction([insert("first"), insert("second")]),
    [{ changes: 1 }, { changes: 1 }],
  );
  assert.equal(
    (await get({ table: "account_balances", kind: "revision" })).revision,
    1,
  );
  assert.equal(
    (
      await store.run("UPDATE account_balances SET free_tao=2 WHERE ss58=?", [
        "first",
      ])
    ).changes,
    1,
  );
  assert.equal(
    (await get({ table: "account_balances", kind: "revision", revision: 2 }))
      .revision,
    2,
  );
  await assert.rejects(store.transaction([insert("third"), insert("first")]));
  assert.equal(
    await db
      .prepare("SELECT count(*) n FROM account_balances WHERE ss58='third'")
      .first("n"),
    0,
  );
  assert.equal(
    (await get({ table: "account_balances", kind: "revision" })).revision,
    2,
  );
  const noExport = selectedD1Store(
    { ...env(), D1_STATE_TABLES: "lane_health" },
    ["lane_health"],
  )!;
  await noExport.run(
    "INSERT INTO lane_health(lane,verdict,checked_at) VALUES('test','ok',1)",
  );
  assert.equal(
    await db
      .prepare(
        "SELECT count(*) n FROM archive_export_revisions WHERE table_name='lane_health'",
      )
      .first("n"),
    0,
  );
});

test("keyset pages retain every row and reject a mutation before the next page or final check", async () => {
  const store = selectedD1Store(env(), ["account_balances"])!;
  await store.run("DELETE FROM account_balances");
  await store.run(
    `INSERT INTO account_balances(ss58,free_tao,reserved_tao,captured_at)
 SELECT value,1,2,1790000000000 FROM json_each(?)`,
    [
      JSON.stringify(
        Array.from(
          { length: 2002 },
          (_, i) => `account-${String(i).padStart(5, "0")}`,
        ),
      ),
    ],
  );
  const base = {
    table: "account_balances",
    kind: "rows",
    columns: ["ss58", "free_tao"],
  };
  const first = await get(base);
  assert.equal(first.rows.length, 2000);
  const last = await get({
    ...base,
    cursor: first.next_cursor,
    revision: first.revision,
  });
  assert.equal(last.rows.length, 2);
  assert.equal(last.next_cursor, null);
  assert.equal(
    new Set([...first.rows, ...last.rows].map((r) => r[0])).size,
    2002,
  );
  await store.run(
    "UPDATE account_balances SET free_tao=3 WHERE ss58='account-00000'",
  );
  assert.equal(
    (
      await handleD1StateExport(
        req({ ...base, cursor: first.next_cursor, revision: first.revision }),
        env(),
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await handleD1StateExport(
        req({
          table: "account_balances",
          kind: "revision",
          revision: first.revision,
        }),
        env(),
      )
    ).status,
    409,
  );
});

test("closed-day pages survive live-day writes and still reject corrections before paging or acknowledgement", async () => {
  const day = "2000-01-01";
  const store = selectedD1Store(env(), ["subnet_snapshots"])!;
  await store.run(
    `WITH RECURSIVE ids(n) AS (SELECT 10000 UNION ALL SELECT n+1 FROM ids WHERE n<12001)
     INSERT INTO subnet_snapshots(netuid,snapshot_date,captured_at) SELECT n,?,1 FROM ids`,
    [day],
  );
  assert.equal(
    (await get({ table: "subnet_snapshots", kind: "schema" })).day_revisions,
    true,
  );
  const base = {
    table: "subnet_snapshots",
    kind: "rows",
    day,
    revision_scope: "day",
    columns: ["netuid", "captured_at"],
  };
  const first = await get(base);
  assert.equal(first.rows.length, 2000);
  await store.run(
    "INSERT INTO subnet_snapshots(netuid,snapshot_date,captured_at) VALUES(10000,?,2)",
    [new Date().toISOString().slice(0, 10)],
  );
  const last = await get({
    ...base,
    cursor: first.next_cursor,
    revision: first.revision,
  });
  assert.deepEqual(last.rows, [
    [12000, 1],
    [12001, 1],
  ]);
  const final = {
    table: base.table,
    kind: "revision",
    day,
    revision_scope: "day",
    revision: first.revision,
  };
  assert.equal((await get(final)).revision, first.revision);
  await store.run(
    "UPDATE subnet_snapshots SET captured_at=3 WHERE netuid=10000 AND snapshot_date=?",
    [day],
  );
  for (const body of [
    final,
    { ...base, cursor: first.next_cursor, revision: first.revision },
  ])
    assert.equal((await handleD1StateExport(req(body), env())).status, 409);
  await store.run(
    "DELETE FROM subnet_snapshots WHERE netuid BETWEEN 10000 AND 12001",
  );
});

test("closed-day revisions include every physical projection, moved day and deletion, with no open-day revision writes", async () => {
  const fixtures = [
    [
      "neuron_daily",
      "neuron_daily_documents",
      "day",
      "shard,stamp,payload",
      "0,1790000000000,jsonb('{}')",
    ],
    [
      "neuron_daily",
      "neuron_daily_members",
      "snapshot_date",
      "uid,shard",
      "0,0",
    ],
    [
      "account_position_daily",
      "account_position_daily_documents",
      "day",
      "shard,stamp,payload",
      "0,1790000000000,jsonb('{}')",
    ],
    [
      "account_position_daily",
      "account_position_daily_members",
      "snapshot_date",
      "account,shard",
      "'fixture',0",
    ],
    [
      "subnet_snapshots",
      "subnet_snapshots",
      "snapshot_date",
      "captured_at",
      "1",
    ],
  ];
  const revision = async (table: string, day: string) =>
    (await get({ table, day, kind: "revision", revision_scope: "day" }))
      .revision;
  for (const [table, physical, column, extra, values] of fixtures) {
    const day = "2000-02-01",
      moved = "2000-02-02";
    const before = await revision(table!, day);
    await db
      .prepare(
        `INSERT INTO ${physical}(netuid,${column},${extra}) VALUES(60000,?,${values})`,
      )
      .bind(day)
      .run();
    const inserted = await revision(table!, day);
    assert.ok(inserted > before);
    await db
      .prepare(`UPDATE ${physical} SET ${column}=${column} WHERE netuid=60000`)
      .run();
    assert.ok((await revision(table!, day)) > inserted);
    const old = await revision(table!, day),
      next = await revision(table!, moved);
    await db
      .prepare(`UPDATE ${physical} SET ${column}=? WHERE netuid=60000`)
      .bind(moved)
      .run();
    assert.ok((await revision(table!, day)) > old);
    assert.ok((await revision(table!, moved)) > next);
    const changed = await revision(table!, moved);
    await db.prepare(`DELETE FROM ${physical} WHERE netuid=60000`).run();
    assert.ok((await revision(table!, moved)) > changed);
    await db
      .prepare(
        `INSERT INTO ${physical}(netuid,${column},${extra}) VALUES(60000,'9999-12-31',${values})`,
      )
      .run();
    await db
      .prepare(`UPDATE ${physical} SET ${column}=${column} WHERE netuid=60000`)
      .run();
    await db.prepare(`DELETE FROM ${physical} WHERE netuid=60000`).run();
    assert.equal(
      await db
        .prepare(
          "SELECT count(*) n FROM archive_export_revisions WHERE table_name=?",
        )
        .bind(`${table}/9999-12-31`)
        .first("n"),
      0,
    );
  }
});

test("day-scoped exports require a closed daily selection and a completed migration", async () => {
  for (const body of [
    { table: "account_balances", day: "2000-01-01", kind: "revision" },
    { table: "subnet_snapshots", kind: "revision" },
    { table: "subnet_snapshots", day: "9999-12-31", kind: "revision" },
    { table: "subnet_snapshots", day: "2000-01-01", kind: "schema" },
  ])
    assert.equal(
      (
        await handleD1StateExport(
          req({ ...body, revision_scope: "day" }),
          env(),
        )
      ).status,
      400,
    );
  await db
    .prepare(
      "DELETE FROM archive_export_revisions WHERE table_name='__closed_day_revisions_v1'",
    )
    .run();
  try {
    assert.equal(
      (await get({ table: "subnet_snapshots", kind: "schema" })).day_revisions,
      false,
    );
    for (const kind of ["rows", "revision"])
      assert.equal(
        (
          await handleD1StateExport(
            req({
              table: "subnet_snapshots",
              kind,
              day: "2000-01-01",
              columns: ["netuid"],
              revision_scope: "day",
            }),
            env(),
          )
        ).status,
        503,
      );
  } finally {
    await db
      .prepare(
        "INSERT INTO archive_export_revisions(table_name,revision) VALUES('__closed_day_revisions_v1',1)",
      )
      .run();
  }
});

test("daily neuron views and composite history watermarks preserve rows without scanning offsets", async () => {
  const stamp = 1790000000000,
    day = new Date(stamp).toISOString().slice(0, 10);
  const rows = [
    {
      netuid: 7,
      uid: 2,
      hotkey: "hot",
      coldkey: "cold",
      active: true,
      validator_permit: false,
      stake_tao: 2,
      emission_tao: 1,
      captured_at: stamp,
    },
  ];
  await writeNeuronDocuments(
    createD1Store(db),
    neuronSnapshotWrite(rows, stamp),
  );
  for (const table of ["neuron_daily", "account_position_daily"]) {
    assert.deepEqual((await get({ table, kind: "days" })).days, [
      { day, rows: 1 },
    ]);
    const result = await get({
      table,
      kind: "rows",
      columns: ["netuid", "uid", "active", "stake_tao"],
      day,
    });
    assert.deepEqual(result.rows, [[7, 2, 1, 2]]);
    const key = table === "neuron_daily" ? 0 : "";
    assert.deepEqual(
      (
        await get({
          table,
          kind: "rows",
          columns: ["netuid"],
          day,
          cursor: [day, 6, key],
          revision: result.revision,
        })
      ).rows,
      [[7]],
    );
    assert.equal(
      (
        await handleD1StateExport(
          req({
            table,
            kind: "rows",
            columns: ["netuid"],
            day,
            cursor: ["2000-01-01", 6, key],
            revision: result.revision,
          }),
          env(),
        )
      ).status,
      400,
    );
  }
  assert.deepEqual(
    (await get({ table: "subnet_snapshots", kind: "days" })).days,
    [],
  );
  await db
    .prepare(
      "INSERT INTO subnet_burn_history(netuid,observed_at,burn_tao) VALUES(?,?,?)",
    )
    .bind(2, 100, 1)
    .run();
  await db
    .prepare(
      "INSERT INTO subnet_burn_history(netuid,observed_at,burn_tao) VALUES(?,?,?)",
    )
    .bind(3, 100, 2)
    .run();
  const result = await get({
    table: "subnet_burn_history",
    kind: "rows",
    columns: ["netuid", "burn_tao"],
    watermark: ["observed_at", "netuid"],
    since: [100, 2],
  });
  assert.deepEqual(result.rows, [[3, 2]]);
});

test("authentication, schema, cursor and body failures cannot execute arbitrary exports", async () => {
  const valid = { table: "account_balances", kind: "rows", columns: ["ss58"] };
  assert.equal(
    (
      await handleD1StateExport(req(valid), {
        ...env(),
        STATE_EXPORT_SECRET: undefined,
      })
    ).status,
    503,
  );
  assert.equal(
    (await handleD1StateExport(req(valid, "POST", "bad"), env())).status,
    401,
  );
  assert.equal(
    (await handleD1StateExport(req(valid, "GET"), env())).status,
    405,
  );
  for (const input of [
    null,
    [],
    { table: "api_keys", kind: "schema" },
    { ...valid, sql: "SELECT secret" },
    { ...valid, columns: undefined },
    { ...valid, columns: ["missing"] },
    { ...valid, columns: ["ss58", "ss58"] },
    { ...valid, cursor: ["x"] },
    { ...valid, cursor: [1, 2], revision: 0 },
    { ...valid, day: "2026-09-21" },
    { ...valid, watermark: ["ss58"], since: ["x"] },
    { ...valid, since: [1] },
    {
      table: "subnet_burn_history",
      kind: "rows",
      columns: ["netuid"],
      watermark: ["observed_at", "netuid"],
      since: [1],
    },
    { table: "account_balances", kind: "days" },
  ]) {
    assert.equal(
      (await handleD1StateExport(req(input), env())).status,
      400,
      JSON.stringify(input),
    );
  }
  for (const bytes of ["", "x".repeat(8200), "{", new Uint8Array([255])]) {
    const request = new Request("https://example.com", {
      method: "POST",
      headers: { "x-state-export-token": "secret" },
      body: bytes,
    });
    assert.equal((await handleD1StateExport(request, env())).status, 400);
  }
  assert.equal(
    (
      await handleD1StateExport(
        new Request("https://example.com", {
          method: "POST",
          headers: { "x-state-export-token": "secret" },
        }),
        env(),
      )
    ).status,
    400,
  );
  for (const overrides of [
    { D1_EXPORT_REVISIONS: undefined },
    { D1_STATE_TABLES: "lane_health" },
    { D1_STATE: undefined },
  ])
    assert.equal(
      (await handleD1StateExport(req(valid), { ...env(), ...overrides }))
        .status,
      503,
    );
});

test("output byte limits produce a resumable prefix or an explicit oversize failure", async () => {
  const fake = (sizes: number[], schema = true) => ({
    prepare() {
      return {
        all: async () => ({
          results: schema
            ? [
                { name: "id", type: "TEXT" },
                { name: "overlay", type: "TEXT" },
              ]
            : [],
        }),
        bind() {
          return this;
        },
      };
    },
    async batch() {
      return [
        { results: [{ revision: 0 }] },
        {
          results: sizes.map((n, i) => ({
            id: String(i),
            overlay: "x".repeat(n),
            _cursor: JSON.stringify([String(i)]),
          })),
        },
      ];
    },
  });
  const input = {
    table: "providers",
    kind: "rows",
    columns: ["id", "overlay"],
  };
  const prefix = await get(input, { D1_STATE: fake([1100000, 1100000]) });
  assert.equal(prefix.rows.length, 1);
  assert.deepEqual(prefix.next_cursor, ["0"]);
  assert.equal(
    (
      await handleD1StateExport(req(input), {
        ...env(),
        D1_STATE: fake([2200000]) as unknown as D1Database,
      })
    ).status,
    413,
  );
  assert.equal(
    (
      await handleD1StateExport(req(input), {
        ...env(),
        D1_STATE: fake([], false) as unknown as D1Database,
      })
    ).status,
    503,
  );
});

test("main and data Workers expose only the protected internal export route", async () => {
  const ctx = {
    waitUntil(p: Promise<unknown>) {
      void p.catch(() => {});
    },
  } as ExecutionContext;
  const payload = { table: "account_balances", kind: "schema" };
  const data = await dataWorker.fetch(req(payload), dataApiEnv(env()), ctx);
  assert.equal(data.status, 200);
  const response = await apiWorker.fetch(
    req(payload),
    apiEnv({
      DATA_API: {
        fetch: (request: Request) =>
          dataWorker.fetch(request, dataApiEnv(env()), ctx),
      },
    }),
    ctx,
  );
  assert.equal(response.status, 200, await response.clone().text());
  const absent = await apiWorker.fetch(req(payload), apiEnv({}), ctx);
  assert.equal(absent.status, 503);
  const bad = await apiWorker.fetch(
    req(payload),
    apiEnv({
      DATA_API: {
        async fetch() {
          throw new Error("unreadable");
        },
      },
    }),
    ctx,
  );
  assert.equal(bad.status, 503);
});

test("price and lifecycle writers advance export revisions through their native write path", async () => {
  const { writeTaoUsdIndexRow } = await import("../workers/data-api.ts");
  const { runSubnetLifecycleLane } = await import("../src/subnet-lifecycle.ts");
  await writeTaoUsdIndexRow(dataApiEnv(env()), {
    block_number: 10,
    observed_at: 1790000000000,
    usd_per_tao: 300,
    price_basis: "wrapped_onchain_median",
    eth_usd: 2000,
    pool_count: 3,
    pools: [],
  });
  assert.equal(
    (await get({ table: "tao_usd_index", kind: "revision" })).revision,
    1,
  );
  await db
    .prepare(
      "INSERT INTO neurons_passes SELECT MAX(captured_at),COUNT(*),COUNT(*),MAX(captured_at)+1 FROM neurons",
    )
    .run();
  const result = await runSubnetLifecycleLane(dataApiEnv(env()), {
    coverageFloor: 1,
    now: () => 1790000000000,
    laneHealthDb: {
      async query() {
        return [];
      },
      async run() {
        return { changes: 1 };
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.events, 1);
  assert.equal(
    (await get({ table: "subnet_lifecycle", kind: "revision" })).revision,
    1,
  );
});
