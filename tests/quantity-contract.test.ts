import assert from "node:assert/strict";
import { test } from "vitest";
import { Miniflare } from "miniflare";
import { PGlite } from "@electric-sql/pglite";
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
    { ...position, alpha_evidence: "{" },
  ])
    assert.equal(alphaPositionQuantity(row, capture).alpha_rao, null);
  assert.equal(alphaPositionQuantity(position, null).alpha_rao, null);
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
