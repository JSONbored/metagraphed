import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeAll, afterAll, test } from "vitest";
import { Miniflare } from "miniflare";
import { readRetainedBlockRows } from "../src/retained-blocks-d1.ts";
import {
  fetchBlockRowsFromR2Sql,
  type BlockFeedQuery,
} from "../src/r2-sql-blocks.ts";
import type { D1StoreBinding } from "../src/d1-store.ts";
import { encodeCursor } from "../src/cursor.ts";
const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('test')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
const AUTHOR = "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F";
const now = Date.now();
const state = {
  network: 0,
  generation: "a".repeat(64),
  table_uuid: "019fc234-642e-7f82-b656-ddb8529315ab",
  snapshot: "9223372036854775806",
  sequence: 99,
  generated_at: now,
  source_rows: 6,
  source_files: 1,
  coverage: null,
};
const row = (
  height: number,
  observed: number | null,
  extra: Record<string, unknown> = {},
) => ({
  block_number: height,
  block_hash: `0x${height}`,
  parent_hash: `0x${height - 1}`,
  author: AUTHOR,
  extrinsic_count: 3,
  event_count: 7,
  spec_version: 240,
  observed_at: observed,
  ...extra,
});
const rows = [
  row(10, 100),
  row(9, 200),
  row(8, 200, { spec_version: 241, event_count: 12 }),
  row(8, 200, { spec_version: 241, event_count: 12 }),
  row(11, 50, { author: null, extrinsic_count: null }),
  row(12, null, { block_hash: null, parent_hash: null }),
];
const env = () => ({
  D1_RETAINED_BLOCKS: db,
  RETAINED_BLOCKS_NETWORKS: "mainnet,testnet",
});
beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  for (const sql of readFileSync(
    new URL(
      "../migrations/retained-blocks/0001_retained_blocks.sql",
      import.meta.url,
    ),
    "utf8",
  ).split("-- statement-breakpoint"))
    await db.prepare(sql).run();
  await db
    .prepare("INSERT INTO history_block_authors(id,address) VALUES(1,?)")
    .bind(AUTHOR)
    .run();
  for (const [id, network, active] of [
    [1, 0, 1],
    [2, 1, 1],
    [3, 0, 0],
  ]) {
    await db
      .prepare(
        "INSERT INTO history_block_sources(id,identity,network,source,expected_rows,received_rows,active) VALUES(?,?,?,?,?,?,?)",
      )
      .bind(id, String(id), network, "{}", rows.length, rows.length, active)
      .run();
    for (const [ordinal, r] of rows.entries())
      await db
        .prepare("INSERT INTO history_blocks VALUES(?,?,?,?,?,?,?,?,?,?,?)")
        .bind(
          network,
          id,
          ordinal,
          r.block_number,
          r.block_hash,
          r.parent_hash,
          r.author === null ? null : 1,
          r.extrinsic_count,
          r.event_count,
          r.spec_version,
          r.observed_at,
        )
        .run();
  }
  for (const network of [0, 1])
    await db
      .prepare("INSERT INTO history_block_state VALUES(?,?,?,?,?,?,?,?,?)")
      .bind(...Object.values({ ...state, network }))
      .run();
  for (const [kind, column] of [
    ["events", "event_count"],
    ["extrinsics", "extrinsic_count"],
  ])
    await db
      .prepare(
        `INSERT INTO history_block_counts SELECT b.network,?,b.${column},COUNT(*) FROM history_blocks b JOIN history_block_sources s ON s.id=b.source_id WHERE s.active=1 AND b.${column} IS NOT NULL GROUP BY b.network,b.${column}`,
      )
      .bind(kind)
      .run();
});
afterAll(async () => runtime.dispose());
test("native D1 preserves source duplicates, nulls, exact tuple order and network ownership", async () => {
  const expected = [rows[5], rows[1], rows[2], rows[3], rows[0], rows[4]];
  for (const network of ["mainnet", "testnet"] as const) {
    const result = await fetchBlockRowsFromR2Sql(
      env(),
      { limit: 10, offset: 0 },
      network,
    );
    assert.deepEqual(result, {
      rows: expected,
      limit: 10,
      offset: 0,
      nextCursor: null,
    });
  }
});
test("every retained block filter and their intersections match the established contract", async () => {
  const cases: [Partial<BlockFeedQuery>, number[]][] = [
    [{ author: AUTHOR }, [12, 9, 8, 8, 10]],
    [{ specVersion: 241 }, [8, 8]],
    [{ blockStart: 10 }, [12, 10, 11]],
    [{ blockEnd: 9 }, [9, 8, 8]],
    [{ from: 100, to: 200 }, [9, 8, 8, 10]],
    [{ minExtrinsics: 3 }, [12, 9, 8, 8, 10]],
    [{ minEvents: 8 }, [8, 8]],
    [{ ceilingBlock: 10 }, [9, 8, 8]],
    [
      {
        author: AUTHOR,
        specVersion: 241,
        blockStart: 8,
        blockEnd: 10,
        from: 100,
        to: 200,
        minExtrinsics: 3,
        minEvents: 10,
        ceilingBlock: 9,
      },
      [8, 8],
    ],
    [{ specVersion: 999 }, []],
  ];
  for (const [query, expected] of cases) {
    const result = await fetchBlockRowsFromR2Sql(env(), {
      limit: 10,
      offset: 0,
      ...query,
    });
    assert.deepEqual(
      result!.rows.map((r) => r.block_number),
      expected,
      JSON.stringify(query),
    );
  }
});
test("cursors seek both columns and suppress offset; malformed cursors mean first page", async () => {
  const nullable = await fetchBlockRowsFromR2Sql(env(), {
    limit: 1,
    offset: 0,
  });
  assert.deepEqual(nullable!.rows, [rows[5]]);
  assert.equal(nullable!.nextCursor, null);
  const first = await fetchBlockRowsFromR2Sql(env(), {
    limit: 1,
    offset: 0,
    from: 0,
  });
  assert.equal(first!.nextCursor, encodeCursor([200, 9]));
  const next = await fetchBlockRowsFromR2Sql(env(), {
    limit: 2,
    offset: 99,
    cursor: first!.nextCursor,
  });
  assert.deepEqual(next!.rows, [rows[2], rows[3]]);
  const after = await fetchBlockRowsFromR2Sql(env(), {
    limit: 10,
    offset: 0,
    cursor: next!.nextCursor,
  });
  assert.deepEqual(after!.rows, [rows[0], rows[4]]);
  const malformed = await fetchBlockRowsFromR2Sql(env(), {
    limit: 1,
    offset: 1,
    cursor: "bad",
    from: 0,
  });
  assert.deepEqual(malformed!.rows, [rows[2]]);
  assert.equal(
    await fetchBlockRowsFromR2Sql(env(), { limit: 1, offset: 251 }),
    null,
  );
  assert.equal(
    await fetchBlockRowsFromR2Sql(env(), {
      limit: 1,
      offset: 0,
      author: "' OR 1=1",
    }),
    null,
  );
});
test("unselected networks retain transitional behavior; selected missing binding declines", async () => {
  for (const e of [
    undefined,
    null,
    {},
    { RETAINED_BLOCKS_NETWORKS: "testnet" },
  ])
    assert.equal(await readRetainedBlockRows(e, [], 1), undefined);
  assert.equal(
    await readRetainedBlockRows({ RETAINED_BLOCKS_NETWORKS: "mainnet" }, [], 1),
    null,
  );
});
function stub(
  receipt: unknown,
  result: unknown = rows,
  success = [true, true],
): D1StoreBinding {
  return {
    prepare: db.prepare.bind(db),
    batch: async () => [
      { success: success[0], results: receipt },
      { success: success[1], results: result },
    ],
  } as unknown as D1StoreBinding;
}
test("selected invalid, absent, stale or inconsistent receipts decline without warehouse fallback", async () => {
  const bad = [
    undefined,
    { ...state, network: 1 },
    { ...state, generated_at: now + 1 },
    { ...state, generated_at: now - 7200001 },
    { ...state, source_files: 7 },
    { ...state, source_files: 0 },
    { ...state, snapshot: Number("9223372036854775806") },
  ];
  for (const receipt of bad) {
    const e = { ...env(), D1_RETAINED_BLOCKS: stub(receipt ? [receipt] : []) };
    assert.equal(await readRetainedBlockRows(e, [], 10, "mainnet", now), null);
  }
  for (const success of [
    [false, true],
    [true, false],
  ])
    assert.equal(
      await readRetainedBlockRows(
        { ...env(), D1_RETAINED_BLOCKS: stub([state], rows, success) },
        [],
        10,
        "mainnet",
        now,
      ),
      null,
    );
  assert.equal(
    await readRetainedBlockRows(
      {
        ...env(),
        D1_RETAINED_BLOCKS: stub([state], [{ block_number: "broken" }]),
      },
      [],
      1,
      "mainnet",
      now,
    ),
    null,
  );
  assert.deepEqual(
    await readRetainedBlockRows(
      {
        ...env(),
        D1_RETAINED_BLOCKS: stub(
          [{ ...state, source_rows: 0, source_files: 0 }],
          [],
        ),
      },
      [],
      10,
      "mainnet",
      now,
    ),
    [],
  );
  assert.equal(
    await fetchBlockRowsFromR2Sql(
      { ...env(), D1_RETAINED_BLOCKS: stub([]) },
      { limit: 1, offset: 0 },
    ),
    null,
  );
});

test("minimum counts use complete cardinalities and reject a snapshot change between the two reads", async () => {
  assert.deepEqual(
    await readRetainedBlockRows(
      env(),
      ["event_count>=999999"],
      10,
      "mainnet",
      now,
      { minEvents: 999999 },
    ),
    [],
  );
  const make = (first: unknown[], second: unknown[]) => {
    let n = 0;
    return {
      ...env(),
      D1_RETAINED_BLOCKS: {
        prepare: db.prepare.bind(db),
        async batch() {
          return ++n === 1 ? first : second;
        },
      } as unknown as D1StoreBinding,
    };
  };
  const receipt = {
    success: true,
    results: [{ ...state, source_rows: 100000 }],
  };
  const histogram = {
    success: true,
    results: [{ kind: "events", matches: 60000 }],
  };
  const data = { success: true, results: rows };
  assert.deepEqual(
    await readRetainedBlockRows(
      make([receipt, histogram], [receipt, data]),
      ["event_count>=1"],
      10,
      "mainnet",
      now,
      { minEvents: 1 },
    ),
    rows,
  );
  for (const first of [
    [{ success: false }, histogram],
    [receipt, { success: false }],
  ])
    assert.equal(
      await readRetainedBlockRows(make(first, []), [], 10, "mainnet", now, {
        minEvents: 1,
      }),
      null,
    );
  assert.equal(
    await readRetainedBlockRows(
      make(
        [receipt, histogram],
        [
          { ...receipt, results: [{ ...state, generation: "b".repeat(64) }] },
          data,
        ],
      ),
      [],
      10,
      "mainnet",
      now,
      { minEvents: 1 },
    ),
    null,
  );
});

test("native plans use equality and ordering indexes instead of sorting broad height ranges", async () => {
  for (const [where, index, expected] of [
    [[], "order", [12, 9, 8, 8, 10, 11]],
    [[`author = '${AUTHOR}'`], "author", [12, 9, 8, 8, 10]],
    [[`author = '${AUTHOR}'`, "spec_version = 241"], "author_spec", [8, 8]],
    [["spec_version = 241"], "spec", [8, 8]],
    [["block_number <= 999999"], "order", [12, 9, 8, 8, 10, 11]],
    [["block_number >= 0"], "order", [12, 9, 8, 8, 10, 11]],
    [["block_number <= 999999", "block_number <= 8"], "height", [8, 8]],
    [
      ["block_number >= 0", "block_number >= 9", "block_number <= 9"],
      "height",
      [9],
    ],
    [["block_number < 9"], "height", [8, 8]],
    [["block_number <= 99", "observed_at >= 100"], "order", [9, 8, 8, 10]],
  ] as [string[], string, number[]][]) {
    const queries: string[] = [];
    const binding = {
      prepare(sql: string) {
        queries.push(sql);
        return db.prepare(sql);
      },
      batch: db.batch.bind(db),
    };
    const actual = await readRetainedBlockRows(
      { ...env(), D1_RETAINED_BLOCKS: binding },
      where,
      100,
      "mainnet",
      now,
    );
    assert.deepEqual(
      actual!.map((r) => r.block_number),
      expected,
    );
    const sql = queries.find((q) => q.startsWith("WITH candidates"))!;
    assert.ok(sql.includes(`INDEXED BY history_blocks_${index}`));
    const plan = await db
      .prepare("EXPLAIN QUERY PLAN " + sql)
      .bind(0, 0, 100)
      .all<{ detail: string }>();
    assert.ok(
      plan.results.some((r) =>
        r.detail.includes(`INDEX history_blocks_${index}`),
      ),
    );
    if (where.length === 2 && where[1] === "block_number <= 8")
      assert.ok(!sql.includes("999999"));
  }
});

test("empty and contradictory height ranges return proven emptiness without reading a candidate page", async () => {
  for (const where of [
    ["block_number >= 99"],
    ["block_number < 0"],
    ["block_number >= 12", "block_number <= 9"],
  ]) {
    const queries: string[] = [];
    const binding = {
      prepare(sql: string) {
        queries.push(sql);
        return db.prepare(sql);
      },
      batch: db.batch.bind(db),
    };
    assert.deepEqual(
      await readRetainedBlockRows(
        { ...env(), D1_RETAINED_BLOCKS: binding },
        where,
        100,
        "mainnet",
        now,
      ),
      [],
    );
    assert.ok(!queries.some((q) => q.startsWith("WITH candidates")));
  }
  await db
    .prepare("UPDATE history_blocks SET block_number=NULL WHERE source_id=1")
    .run();
  try {
    assert.deepEqual(
      await readRetainedBlockRows(
        env(),
        ["block_number <= 99"],
        100,
        "mainnet",
        now,
      ),
      [],
    );
  } finally {
    await db.batch(
      rows.map((r, ordinal) =>
        db
          .prepare(
            "UPDATE history_blocks SET block_number=? WHERE source_id=1 AND ordinal=?",
          )
          .bind(r.block_number, ordinal),
      ),
    );
  }
});

test("height planning preserves minimum-count selection and rejects malformed or changed metadata", async () => {
  assert.deepEqual(
    (await readRetainedBlockRows(
      env(),
      ["block_number <= 99", "event_count >= 12"],
      100,
      "mainnet",
      now,
      { minEvents: 12 },
    ))!.map((r) => r.block_number),
    [8, 8],
  );
  for (const bounds of [
    { first_block: null, last_block: 12 },
    { first_block: 8, last_block: null },
    { first_block: 12, last_block: 8 },
    { first_block: "8", last_block: 12 },
  ]) {
    const binding = {
      prepare: db.prepare.bind(db),
      batch: async () => [
        { success: true, results: [state] },
        { success: true, results: [bounds] },
      ],
    } as unknown as D1StoreBinding;
    assert.equal(
      await readRetainedBlockRows(
        { ...env(), D1_RETAINED_BLOCKS: binding },
        ["block_number <= 99"],
        100,
        "mainnet",
        now,
      ),
      null,
    );
  }
  let batch = 0;
  const binding = {
    prepare: db.prepare.bind(db),
    batch: async () =>
      ++batch === 1
        ? [
            { success: true, results: [state] },
            { success: true, results: [{ first_block: 8, last_block: 12 }] },
          ]
        : [
            {
              success: true,
              results: [{ ...state, generation: "b".repeat(64) }],
            },
            { success: true, results: rows },
          ],
  } as unknown as D1StoreBinding;
  assert.equal(
    await readRetainedBlockRows(
      { ...env(), D1_RETAINED_BLOCKS: binding },
      ["block_number <= 99"],
      100,
      "mainnet",
      now,
    ),
    null,
  );
});
