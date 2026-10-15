import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createD1Store } from "../src/d1-store.ts";
import { writeAlphaSnapshotD1 } from "../src/alpha-snapshot-d1.ts";
import { alphaQuantityStore } from "../src/alpha-quantity.ts";
import {
  buildSubnetYield,
  buildSubnetYieldHistory,
} from "../src/subnet-yield.ts";
import { buildChainYield } from "../src/chain-yield.ts";
import {
  SubnetYieldArtifactSchema,
  SubnetYieldHistoryArtifactSchema,
} from "../schemas-src/routes/subnet-yield.ts";
import { ChainYieldArtifactSchema } from "../schemas-src/routes/chain-yield.ts";
import { buildAccountsList } from "../src/accounts-list.ts";
import { test } from "vitest";
import { Miniflare } from "miniflare";
import { PGlite } from "@electric-sql/pglite";
import {
  loadNominatorPositions,
  buildNominatorPositions,
} from "../src/validator-nominator-positions.ts";
import {
  loadSubnetHolders,
  buildSubnetHolders,
} from "../src/subnet-holders.ts";
import { loadChainHolders, buildChainHolders } from "../src/chain-holders.ts";
import { alphaHolderCte } from "../src/alpha-holder-sql.ts";
import {
  ALPHA_GENESIS,
  ALPHA_RUNTIMES,
} from "../src/alpha-runtime-identity.ts";
import {
  AlphaQuantityCaptureSchema,
  alphaPositionQuantity,
  loadAlphaQuantityCapture,
} from "../src/alpha-quantity.ts";
import { buildAccountPositions } from "../src/account-nominator-positions.ts";
import { AccountPositionsArtifactSchema } from "../schemas-src/routes/account-positions.ts";
import {
  buildValidatorDetail,
  buildGlobalValidators,
} from "../src/metagraph-neurons.ts";
import { buildAccountPortfolio } from "../src/account-portfolio.ts";
import { formatAccountPosition } from "../src/account-position-history.ts";

const at = 1791960000000;
const capture = AlphaQuantityCaptureSchema.parse({
  captured_at: at,
  block_number: 9000000,
  block_hash: "0x" + "a".repeat(64),
  genesis_hash: ALPHA_GENESIS,
  spec_version: 454,
  code_hash: ALPHA_RUNTIMES[454].code,
  metadata_sha256: ALPHA_RUNTIMES[454].metadata,
  expected_rows: 2,
  received_rows: 2,
  expected_chunks: 1,
  received_chunks: 1,
  completed_at: at + 1,
  selected: 1,
});
const evidence = {
  share: { legacy_bits: "18446744073709551616", v2: null },
  denominator: { legacy_bits: "18446744073709551616", v2: null },
  total_alpha_rao: "18446744073709551615",
  pool_epoch: null,
  member_epoch: null,
};
const position = {
  hotkey: "h",
  netuid: 1,
  source: "alpha",
  captured_at: at,
  share_fraction: 1,
  alpha_rao: evidence.total_alpha_rao,
  alpha_evidence: JSON.stringify(evidence),
};

test("legacy relationships and Root do not acquire balances from weighted neuron values or prices", () => {
  const old = {
    hotkey: "unregistered",
    netuid: 7,
    share_fraction: null,
    captured_at: at,
  };
  const result = buildAccountPositions(
    [old, { ...old, netuid: 0 }],
    new Map([["unregistered|7", 1e12]]),
    "account",
  );
  assert.equal(result.schema_version, 2);
  assert.equal(result.position_count, 2);
  assert.equal(result.total_stake_alpha, null);
  for (const row of result.positions) {
    assert.equal(row.stake_tao, null);
    assert.equal(row.alpha_rao, null);
    assert.equal(row.quantity_status, "unqualified");
  }
  assert(AccountPositionsArtifactSchema.safeParse(result).success);
});

test("qualified exact rao retain zero and provenance; mismatched amount, source, capture or evidence remain unknown", () => {
  assert.equal(
    alphaPositionQuantity(position, capture).alpha_rao,
    evidence.total_alpha_rao,
  );
  assert.equal(
    alphaPositionQuantity(position, capture).provenance?.block_hash,
    capture.block_hash,
  );
  const zero = {
    ...position,
    alpha_rao: "0",
    alpha_evidence: JSON.stringify({
      ...evidence,
      share: { legacy_bits: "0", v2: null },
    }),
  };
  assert.equal(alphaPositionQuantity(zero, capture).alpha_rao, "0");
  for (const row of [
    { ...position, alpha_rao: "1" },
    { ...position, source: "self-stake" },
    { ...position, captured_at: at + 1 },
    { ...position, netuid: 0 },
    { ...position, netuid: -1 },
    { ...position, netuid: 1.5 },
    { ...position, netuid: 65536 },
    { ...position, alpha_evidence: "{" },
  ])
    assert.equal(alphaPositionQuantity(row, capture).alpha_rao, null);
  assert.equal(alphaPositionQuantity(position, null).alpha_rao, null);
  assert.equal(
    alphaPositionQuantity({ ...position, captured_at: String(at) }, capture)
      .alpha_rao,
    position.alpha_rao,
  );
  for (const captured_at of [Number.MAX_SAFE_INTEGER, "", "1e12", "001", NaN])
    assert(
      !AlphaQuantityCaptureSchema.safeParse({ ...capture, captured_at })
        .success,
    );
  assert.deepEqual(
    AlphaQuantityCaptureSchema.parse(
      Object.fromEntries(
        Object.entries(capture).map(([key, value]) => [
          key,
          typeof value === "number" &&
          !["spec_version", "selected"].includes(key)
            ? String(value)
            : value,
        ]),
      ),
    ),
    capture,
  );
  const result = buildAccountPositions(
    [position, zero],
    null,
    "account",
    capture,
  );
  assert.equal(result.total_stake_alpha, null);
  assert(AccountPositionsArtifactSchema.safeParse(result).success);
});

test("partial, foreign-runtime, missing-metadata and failed source reads cannot qualify a capture", async () => {
  for (const value of [
    { ...capture, received_rows: 1 },
    { ...capture, selected: 0 },
    { ...capture, code_hash: "0x" + "0".repeat(64) },
    null,
  ])
    assert.equal(
      await loadAlphaQuantityCapture({ first: async () => value }),
      null,
    );
  assert.equal(
    await loadAlphaQuantityCapture({
      first: async () => {
        throw Error("read failed");
      },
    }),
    null,
  );
  assert.equal(await loadAlphaQuantityCapture(undefined), null);
  assert.deepEqual(
    await loadAlphaQuantityCapture({ first: async () => capture }),
    capture,
  );
});

test("validator and registered-account observations expose weights without native holdings, portfolio value or APY", () => {
  const rows = [
    {
      hotkey: "h",
      coldkey: "c",
      netuid: 0,
      uid: 0,
      stake_tao: 1e9,
      emission_tao: 1,
      validator_permit: 1,
      captured_at: at,
    },
    {
      hotkey: "h",
      coldkey: "c",
      netuid: 7,
      uid: 1,
      stake_tao: 2e9,
      emission_tao: 2,
      validator_permit: 1,
      captured_at: at,
    },
  ];
  const options = {
    priceByNetuid: new Map([[7, 100]]),
    tempoByNetuid: new Map([[7, 360]]),
  };
  const detail = buildValidatorDetail(rows, "h", options);
  const global = buildGlobalValidators(rows, options).validators as Record<
    string,
    unknown
  >[];
  for (const row of [detail, ...global]) {
    assert.equal(row.total_stake_tao, null);
    assert.equal(row.root_stake_tao, null);
    assert.equal(row.alpha_stake_tao, null);
    assert.equal(row.apy_estimate, null);
  }
  assert.equal(
    (detail.subnets as Record<string, unknown>[])[1].voting_weight,
    2e9,
  );
  const portfolio = buildAccountPortfolio(rows, "h", options);
  assert.equal(portfolio.total_stake_tao, null);
  assert.equal(portfolio.overall_yield, null);
  assert.equal(formatAccountPosition(rows[1])?.stake_tao, null);
  assert.equal(formatAccountPosition(rows[1])?.yield, null);
});

test("both native SQL engines sum and rank exact rao beyond u64 and floating-point precision", async () => {
  const runtime = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('fixture')}}",
    compatibilityDate: "2026-06-06",
    d1Databases: ["DB"],
  });
  const pg = new PGlite();
  try {
    const db = await runtime.getD1Database("DB");
    const ddl = [
      "CREATE TABLE nominator_positions(coldkey TEXT,hotkey TEXT,netuid INTEGER,alpha_rao TEXT,captured_at BIGINT,source TEXT)",
      "CREATE TABLE alpha_snapshot_passes(captured_at BIGINT,selected INTEGER,completed_at BIGINT)",
    ];
    for (const sql of ddl) {
      await db.prepare(sql).run();
      await pg.exec(sql);
    }
    await db
      .prepare("INSERT INTO alpha_snapshot_passes VALUES(?,1,?)")
      .bind(at, at + 1)
      .run();
    await pg.query("INSERT INTO alpha_snapshot_passes VALUES($1,1,$2)", [
      at,
      at + 1,
    ]);
    const rows = [
      ["a", "h1", 1, "18446744073709551615"],
      ["a", "h2", 1, "18446744073709551615"],
      ["b", "h1", 1, "18446744073709551615"],
      ["b", "h2", 1, "18446744073709551614"],
      ["zero", "h", 1, "0"],
      ["a", "h", 7, "1"],
      ["root", "h", 0, "999"],
    ];
    for (const row of rows) {
      await db
        .prepare("INSERT INTO nominator_positions VALUES(?,?,?,?,?,'alpha')")
        .bind(...row, at)
        .run();
      await pg.query(
        "INSERT INTO nominator_positions VALUES($1,$2,$3,$4,$5,'alpha')",
        [...row, at],
      );
    }
    const sql = `WITH ${alphaHolderCte(at)} SELECT netuid,coldkey,alpha_rao FROM holder ORDER BY netuid,alpha_key DESC,coldkey`;
    const sqlite = (await db.prepare(sql).all()).results;
    const postgres = (await pg.query(sql)).rows;
    assert.deepEqual(sqlite, postgres);
    assert.equal(sqlite[0].alpha_rao, "36893488147419103230");
    assert.equal(sqlite[1].alpha_rao, "36893488147419103229");
    assert.equal(sqlite[2].alpha_rao, "0");
    assert.equal(sqlite[3].netuid, 7);
    assert.equal(sqlite.length, 4);
    assert.throws(() => alphaHolderCte(NaN), /Invalid qualified/);
  } finally {
    await runtime.dispose();
    await pg.close();
  }
});

test("native actual promotions choose finalized ownership and decline publication races without rewriting historical receipts", async () => {
  const frozen = JSON.parse(
    readFileSync(
      new URL("./fixtures/alpha-runtime/frozen-478.json", import.meta.url),
      "utf8",
    ),
  );
  const at = frozen.alpha_snapshot.captured_at;
  for (const family of ["nominator", "subnet", "chain"] as const) {
    const runtime = new Miniflare({
      modules: true,
      script: "export default {fetch(){return new Response('fixture')}}",
      compatibilityDate: "2026-06-06",
      d1Databases: ["DB"],
    });
    try {
      const db = await runtime.getD1Database("DB");
      for (const file of [
        "0010_ledger_state.sql",
        "0016_archive_export_revisions.sql",
        "0040_self_stake_snapshot_receipts.sql",
        "0043_alpha_runtime_snapshots.sql",
        "0044_nominator_daily_captures.sql",
      ])
        for (const sql of readFileSync(
          new URL(`../migrations/d1/${file}`, import.meta.url),
          "utf8",
        ).split("-- statement-breakpoint"))
          if (sql.trim()) await db.prepare(sql).run();
      const packet = (
        capturedAt: number,
        block: number,
        empty = false,
        partial = false,
      ) => ({
        alpha_snapshot: {
          ...frozen.alpha_snapshot,
          captured_at: capturedAt,
          block_number: block,
          block_hash: "0x" + block.toString(16).padStart(64, "0"),
          scanned_legacy: 0,
          scanned_v2: 10,
          total_rows: empty ? 0 : partial ? 2 : 1,
          total_chunks: partial ? 2 : 1,
          index: 0,
        },
        rows: empty
          ? []
          : [
              {
                coldkey: "c",
                hotkey: "h",
                netuid: 23,
                evidence: frozen.members[0].evidence,
              },
            ],
      });
      const original = packet(at + 20, frozen.alpha_snapshot.block_number);
      const next = packet(at + 10, frozen.alpha_snapshot.block_number + 1);
      const write = (p: unknown) => writeAlphaSnapshotD1(db, p, at + 100000);
      await write(original);
      const direct = createD1Store(db);
      const readFamily = (store: typeof direct) =>
        family === "nominator"
          ? loadNominatorPositions(store, "h")
          : family === "subnet"
            ? loadSubnetHolders(store, 23)
            : loadChainHolders(store);
      const shape = (read: Awaited<ReturnType<typeof readFamily>>) =>
        family === "nominator"
          ? buildNominatorPositions(
              read as Awaited<ReturnType<typeof loadNominatorPositions>>,
              "h",
            )
          : family === "subnet"
            ? buildSubnetHolders(
                read as Awaited<ReturnType<typeof loadSubnetHolders>>,
                23,
              )
            : buildChainHolders(
                read as Awaited<ReturnType<typeof loadChainHolders>>,
              );
      const count =
        family === "nominator"
          ? "nominator_count"
          : family === "subnet"
            ? "holder_count"
            : "subnet_count";
      assert.equal(shape(await readFamily(direct))[count], 1);
      let published = false;
      const racing = {
        ...direct,
        async query<Row>(sql: string, values: unknown[] = []): Promise<Row[]> {
          if (!published) {
            published = true;
            await write(next);
          }
          return direct.query<Row>(sql, values);
        },
      };
      const raced = await readFamily(racing);
      assert.equal(raced.decline, "runtime_positions_unqualified");
      assert.equal(shape(raced)[count], null);
      assert.equal(
        await db
          .prepare(
            "SELECT COUNT(*) n FROM alpha_snapshot_passes WHERE selected=1",
          )
          .first("n"),
        2,
      );
      await db.prepare("DROP INDEX alpha_snapshot_selected").run();
      await db.prepare("PRAGMA reverse_unordered_selects=ON").run();
      assert.equal(
        (await loadAlphaQuantityCapture(direct))?.captured_at,
        next.alpha_snapshot.captured_at,
        "higher finalized block wins despite earlier capture time, retained receipts and changed unordered scans",
      );
      const stale = packet(at + 30, frozen.alpha_snapshot.block_number - 1);
      await write(stale);
      await write(
        packet(at + 40, frozen.alpha_snapshot.block_number + 2, false, true),
      );
      assert.equal(
        (await loadAlphaQuantityCapture(direct))?.captured_at,
        next.alpha_snapshot.captured_at,
        "newer incomplete and stale unselected receipts cannot replace current ownership",
      );
      await write(
        packet(at + 50, frozen.alpha_snapshot.block_number + 3, true),
      );
      const zero = await readFamily(direct);
      assert.equal(zero.decline, null);
      assert.equal(
        shape(zero)[count],
        0,
        "a genuinely empty current promoted census is measured zero",
      );
      await db
        .prepare(
          "UPDATE alpha_snapshot_passes SET completed_at=NULL WHERE block_number=?",
        )
        .bind(frozen.alpha_snapshot.block_number + 3)
        .run();
      assert.equal(
        await loadAlphaQuantityCapture(direct),
        null,
        "a latest selected but incomplete owner must not borrow a prior receipt",
      );
      await db
        .prepare(
          "UPDATE alpha_snapshot_passes SET completed_at=? WHERE block_number=?",
        )
        .bind(at + 100000, frozen.alpha_snapshot.block_number + 3)
        .run();
      // Isolated corruption fixture: retain FK-valid metadata with a foreign identity.
      await db
        .prepare("INSERT INTO alpha_runtime_metadata VALUES(?,?,?,?)")
        .bind("f".repeat(64), "0x" + "f".repeat(64), 478, "0x" + "00".repeat(6))
        .run();
      await db
        .prepare(
          "UPDATE alpha_snapshot_passes SET metadata_sha256=? WHERE block_number=?",
        )
        .bind("f".repeat(64), frozen.alpha_snapshot.block_number + 3)
        .run();
      assert.equal(
        await loadAlphaQuantityCapture(direct),
        null,
        "invalid latest identity must not borrow an older promoted capture",
      );
      const broken = await readFamily(direct);
      assert.equal(shape(broken)[count], null);
    } finally {
      await runtime.dispose();
    }
  }
});

test("declared quantity ownership cannot span stores and missing weights remain unknown", () => {
  const binding = {
    prepare: () => {
      throw Error("read not needed");
    },
    batch: async () => [],
  };
  for (const tables of [
    "nominator_positions",
    "nominator_positions,alpha_snapshot_passes",
    "alpha_runtime_metadata",
  ])
    assert.equal(
      alphaQuantityStore({ D1_STATE: binding, D1_STATE_TABLES: tables }),
      undefined,
    );
  assert(
    alphaQuantityStore({
      D1_STATE: binding,
      D1_STATE_TABLES:
        "nominator_positions,alpha_snapshot_passes,alpha_runtime_metadata",
    }),
  );
  for (const stake_tao of [null, undefined, "", "bad", -1]) {
    const result = buildAccountsList(
      [{ hotkey: "h", netuid: 1, uid: 0, stake_tao }],
      { priceByNetuid: new Map() },
    );
    assert.equal(result.accounts[0].subnets[0].voting_weight, null);
  }
  const zero = buildAccountsList(
    [{ hotkey: "h", netuid: 1, uid: 0, stake_tao: 0 }],
    { priceByNetuid: new Map() },
  );
  assert.equal(zero.accounts[0].subnets[0].voting_weight, 0);
});

test("public snapshot and historical yield contracts preserve observations and withhold returns on voting-weight denominators", () => {
  const rows = [
    {
      uid: 0,
      hotkey: "h",
      netuid: 1,
      validator_permit: 1,
      stake_tao: 100,
      emission_tao: 10,
      captured_at: at,
      snapshot_date: "2026-10-13",
    },
    {
      uid: 1,
      hotkey: "other",
      netuid: 1,
      stake_tao: null,
      emission_tao: null,
      captured_at: at,
      snapshot_date: "2026-10-13",
    },
  ];
  const subnet = buildSubnetYield(rows, 1);
  assert.equal(subnet.neuron_count, 2);
  assert.equal(subnet.total_stake_alpha, null);
  assert.equal(subnet.subnet_yield, null);
  assert.deepEqual(
    (subnet.neurons as Record<string, unknown>[]).map(
      (row) => row.voting_weight,
    ),
    [100, null],
  );
  assert(SubnetYieldArtifactSchema.safeParse(subnet).success);
  const chain = buildChainYield([...rows, { ...rows[0], netuid: 2 }]);
  assert.equal(chain.total_stake_alpha, null);
  assert.equal(chain.total_emission_alpha, null);
  assert.equal(chain.network_yield, null);
  assert.equal(chain.distribution, null);
  assert(ChainYieldArtifactSchema.safeParse(chain).success);
  const history = buildSubnetYieldHistory(rows, 1, { window: "30d" });
  assert.equal(
    (history.points as Record<string, unknown>[])[0].subnet_yield,
    null,
  );
  assert(SubnetYieldHistoryArtifactSchema.safeParse(history).success);
});
