import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import * as alpha from "../src/alpha-runtime-identity.ts";
import {
  buildAccountPositions,
  POSITIONS_DEGRADED_UNPRICEABLE,
} from "../src/account-nominator-positions.ts";
import * as hotPositions from "../src/nominator-positions-hot-tier.ts";
import * as coldPositions from "../src/nominator-positions-cold-tier.ts";
import { loadSubnetHolders } from "../src/subnet-holders.ts";
import { loadChainHolders } from "../src/chain-holders.ts";
import * as nominatorPositions from "../src/validator-nominator-positions.ts";
import { topHoldersHoldings } from "../src/top-holders-holdings.ts";
import {
  loadTopHoldersFlowTier,
  TOP_HOLDERS_FLOW_PROJECTION_KEY,
} from "../src/top-holders-flow-tier.ts";
import * as accountSchema from "../schemas-src/routes/account-positions.ts";
import { handleRequest } from "../workers/api.ts";
import {
  decodeWatermarkKey,
  resetDecodeWatermarkCache,
} from "../src/decode-watermark.ts";

const COLDKEY = "5Df7xwEPkZm4itD3PfSzHsV9extvnQpTFBiNCSgBCJtxEP9e";
const HOTKEY = "5FyVinYphF6JS5FZHzhMQffxtgbz1WxwUEBAxTRo9nABwb5g";
const STAMP = 1_785_634_702_670;
const { ALPHA_GENESIS, ALPHA_RUNTIMES } = alpha;
const { loadAccountPositionsFromStore } = hotPositions;
const { loadAccountPositionsColdTier } = coldPositions;
const { loadNominatorPositions } = nominatorPositions;
const { AccountPositionsArtifactSchema } = accountSchema;
const ACCOUNT_READERS = [
  loadAccountPositionsFromStore,
  loadAccountPositionsColdTier,
];
let sqlite: InstanceType<typeof DatabaseSync>;
let seen: string[];
let afterRead: ((sql: string) => void) | undefined;

function query<T>(text: string, values: unknown[] = []): T[] {
  seen.push(text);
  const rows = sqlite.prepare(text).all(...(values as never[])) as T[];
  afterRead?.(text);
  return rows;
}
function store() {
  return {
    async query<T>(text: string, values: unknown[] = []) {
      return query<T>(text, values);
    },
    async first(text: string, values: unknown[] = []) {
      return query(text, values)[0] ?? null;
    },
  };
}
function environment(): Env {
  const binding = {
    prepare(text: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...bound: unknown[]) {
          values = bound;
          return statement;
        },
        async all() {
          return { success: true, results: query(text, values), meta: {} };
        },
      };
      return statement;
    },
    async batch() {
      throw new Error("reader fixture forbids writes");
    },
  };
  return {
    D1_STATE: binding,
    D1_STATE_TABLES: [
      "nominator_positions",
      "nominator_positions_passes",
      "nominator_scan_receipts",
      "hotkey_alpha",
      "hotkey_alpha_passes",
      "account_balances",
      "account_balances_passes",
      "subnet_snapshots",
      "neurons",
    ].join(","),
  } as unknown as Env;
}
function capture(spec: 454 | 478 | 479 = 478, at = STAMP, block = 100) {
  const runtime = ALPHA_RUNTIMES[spec];
  const metadata = sqlite.prepare(
    "INSERT OR IGNORE INTO alpha_runtime_metadata VALUES(?,?,?)",
  );
  metadata.run(runtime.metadata, runtime.code, spec);
  const sql = `INSERT INTO alpha_snapshot_passes VALUES(
    ?,?, ?,?,?,?, ?,1,1,1,1,?,1)`;
  const pass = sqlite.prepare(sql);
  pass.run(
    at,
    block,
    `0x${String(block).padStart(64, "0")}`,
    ALPHA_GENESIS,
    spec,
    runtime.code,
    runtime.metadata,
    at + 1,
  );
}
function position(
  rao: string | null = "2500000000",
  at = STAMP,
  fraction: number | null = 0.25,
) {
  const sql = "INSERT INTO alpha_snapshot_rows VALUES(?,?,?,?,?,?)";
  const statement = sqlite.prepare(sql);
  statement.run(at, COLDKEY, HOTKEY, 7, fraction, rao);
}

beforeEach(() => {
  seen = [];
  afterRead = undefined;
  sqlite = new DatabaseSync(":memory:");
  const schemaSql = `
    CREATE TABLE alpha_runtime_metadata(sha256 TEXT PRIMARY KEY,code_hash TEXT,spec_version INTEGER);
    CREATE TABLE alpha_snapshot_passes(captured_at INTEGER,block_number INTEGER,block_hash TEXT,
      genesis_hash TEXT,spec_version INTEGER,code_hash TEXT,metadata_sha256 TEXT,
      expected_rows INTEGER,received_rows INTEGER,expected_chunks INTEGER,received_chunks INTEGER,
      completed_at INTEGER,selected INTEGER);
    CREATE TABLE alpha_snapshot_rows(captured_at INTEGER,coldkey TEXT,hotkey TEXT,
      netuid INTEGER,share_fraction REAL,alpha_rao TEXT);
    CREATE TABLE nominator_positions(coldkey TEXT,hotkey TEXT,netuid INTEGER,
      share_fraction REAL,captured_at INTEGER,source TEXT DEFAULT 'alpha');
    CREATE TABLE hotkey_alpha(hotkey TEXT,netuid INTEGER,total_alpha REAL,captured_at INTEGER);
    CREATE TABLE hotkey_alpha_passes(captured_at INTEGER,expected_rows INTEGER,received_rows INTEGER,completed_at INTEGER);
    CREATE TABLE neurons(hotkey TEXT,netuid INTEGER,stake_tao REAL);
    CREATE TABLE account_balances(ss58 TEXT,free_tao REAL);
    CREATE TABLE account_balances_passes(captured_at INTEGER,expected_rows INTEGER,received_rows INTEGER,completed_at INTEGER);
    CREATE TABLE subnet_snapshots(netuid INTEGER,snapshot_date TEXT,alpha_price_tao REAL);
  `;
  sqlite.exec(schemaSql);
  const positionSql =
    "INSERT INTO nominator_positions(coldkey,hotkey,netuid,share_fraction,captured_at) VALUES(?,?,?,?,?)";
  const positions = sqlite.prepare(positionSql);
  positions.run(COLDKEY, HOTKEY, 7, 0.9, STAMP - 100);
  const poolSql = "INSERT INTO hotkey_alpha VALUES(?,?,?,?)";
  const pools = sqlite.prepare(poolSql);
  pools.run(HOTKEY, 7, 1000, STAMP - 100);
  const poolPassSql = "INSERT INTO hotkey_alpha_passes VALUES(?,?,?,?)";
  const poolPasses = sqlite.prepare(poolPassSql);
  poolPasses.run(STAMP - 100, 1, 1, STAMP - 99);
  const neurons = sqlite.prepare("INSERT INTO neurons VALUES(?,?,?)");
  neurons.run(HOTKEY, 7, 1000);
  const balances = sqlite.prepare("INSERT INTO account_balances VALUES(?,?)");
  balances.run(COLDKEY, 10);
  const balancePassSql = "INSERT INTO account_balances_passes VALUES(?,?,?,?)";
  const balancePasses = sqlite.prepare(balancePassSql);
  balancePasses.run(STAMP - 10, 1, 1, STAMP - 9);
  sqlite.exec("INSERT INTO subnet_snapshots VALUES(7,'2026-10-16',2)");
});
afterEach(() => {
  sqlite.close();
  vi.unstubAllGlobals();
});

describe("canonical Alpha quantities across existing readers", () => {
  test.each([478, 479] as const)(
    "runtime%i readers use exact current capture values instead of legacy pool or neuron quantities",
    async (spec) => {
      capture(spec);
      position();
      const env = environment();
      for (const load of ACCOUNT_READERS) {
        const result = await load(env, COLDKEY);
        assert.ok(result);
        assert.equal(result?.positions[0].stake_tao, 2.5);
        assert.equal(result.total_stake_alpha, 2.5);
        assert.equal(result.captured_at, new Date(STAMP).toISOString());
        AccountPositionsArtifactSchema.parse(result);
      }
      assert.equal((await loadSubnetHolders(store(), 7)).rows[0].alpha, 2.5);
      assert.equal((await loadChainHolders(store())).rows[0].total_alpha, 2.5);
      const nominators = await loadNominatorPositions(store(), HOTKEY);
      assert.equal(nominators.rows[0].alpha, 2.5);
      const holdings = await topHoldersHoldings(env);
      assert.ok(holdings);
      assert.deepEqual(holdings?.cells.get(COLDKEY), {
        free_tao: 10,
        delegated_tao: 5,
        total_tao: 15,
      });
      assert.equal(holdings.alphaCapturedAt, STAMP);
      assert.ok(!seen.some((text) => text.includes("FROM neurons")));
      assert.ok(!seen.some((text) => text.includes("JOIN hotkey_alpha")));
    },
  );

  test("a newer mismatched runtime identity cannot borrow older qualified captures or legacy values", async () => {
    capture(478, STAMP - 1, 99);
    position("99000000000", STAMP - 1);
    capture(479);
    position(null);
    const sql =
      "UPDATE alpha_runtime_metadata SET spec_version=478 WHERE sha256=?";
    const metadata = sqlite.prepare(sql);
    metadata.run(ALPHA_RUNTIMES[479].metadata);
    for (const load of ACCOUNT_READERS) {
      const result = await load(environment(), COLDKEY);
      assert.ok(result);
      assert.equal(result?.position_count, 0);
      assert.equal(result.degraded?.reason, POSITIONS_DEGRADED_UNPRICEABLE);
      assert.ok(result.degraded);
      assert.equal(
        result.degraded.snapshot_captured_at,
        new Date(STAMP).toISOString(),
      );
      AccountPositionsArtifactSchema.parse(result);
    }
    assert.equal(
      (await loadSubnetHolders(store(), 7)).decline,
      "pool_totals_unproven",
    );
    assert.equal(
      (await loadChainHolders(store())).decline,
      "pool_totals_unproven",
    );
    assert.equal(
      (await loadNominatorPositions(store(), HOTKEY)).decline,
      "pool_totals_unproven",
    );
    const holdings = await topHoldersHoldings(environment());
    assert.ok(holdings);
    assert.deepEqual(holdings?.sorts, ["free_tao"]);
    assert.deepEqual(holdings.cells.get(COLDKEY), { free_tao: 10 });
    assert.ok(!seen.some((text) => text.includes("FROM alpha_snapshot_rows")));
  });

  test("installed schema with no selected capture never exposes legacy quantities", async () => {
    const account = await loadAccountPositionsFromStore(environment(), COLDKEY);
    assert.equal(account?.degraded?.reason, POSITIONS_DEGRADED_UNPRICEABLE);
    assert.equal(
      (await loadSubnetHolders(store(), 7)).decline,
      "pool_totals_unproven",
    );
    assert.equal(
      (await loadChainHolders(store())).decline,
      "pool_totals_unproven",
    );
    assert.equal(
      (await loadNominatorPositions(store(), HOTKEY)).decline,
      "pool_totals_unproven",
    );
    const holdings = await topHoldersHoldings(environment());
    assert.deepEqual(holdings?.sorts, ["free_tao"]);
  });

  test("self-stake coexistence declines only the affected account, validator and subnet scopes", async () => {
    capture();
    position();
    const cases = [
      [COLDKEY, "other-hotkey", 8, true, false, false],
      ["other-coldkey", HOTKEY, 8, false, true, false],
      ["other-coldkey", "other-hotkey", 7, false, false, true],
    ] as const;
    for (const scenario of cases) {
      const [
        coldkey,
        hotkey,
        netuid,
        accountDeclines,
        validatorDeclines,
        subnetDeclines,
      ] = scenario;
      sqlite.exec("DELETE FROM nominator_positions WHERE source='self-stake'");
      const insertSelfStake = sqlite.prepare(
        "INSERT INTO nominator_positions VALUES(?,?,?,?,?,'self-stake')",
      );
      insertSelfStake.run(coldkey, hotkey, netuid, 1, STAMP);
      for (const load of ACCOUNT_READERS) {
        const result = await load(environment(), COLDKEY);
        assert.ok(result);
        assert.equal(
          result.degraded?.reason,
          accountDeclines ? POSITIONS_DEGRADED_UNPRICEABLE : undefined,
        );
      }
      assert.equal(
        (await loadNominatorPositions(store(), HOTKEY)).decline,
        validatorDeclines ? "pool_totals_unproven" : null,
      );
      assert.equal(
        (await loadSubnetHolders(store(), 7)).decline,
        subnetDeclines ? "pool_totals_unproven" : null,
      );
      assert.equal(
        (await loadChainHolders(store())).decline,
        "pool_totals_unproven",
      );
      const holdings = await topHoldersHoldings(environment());
      assert.deepEqual(holdings?.sorts, ["free_tao"]);
    }
  });

  test.each([478, 479] as const)(
    "runtime%i NULL retained quantities never become omitted addends in a healthy answer",
    async (spec) => {
      capture(spec);
      position(null);
      for (const load of ACCOUNT_READERS) {
        const result = await load(environment(), COLDKEY);
        assert.ok(result);
        assert.equal(result.position_count, 0);
        assert.equal(result.degraded?.reason, POSITIONS_DEGRADED_UNPRICEABLE);
        AccountPositionsArtifactSchema.parse(result);
      }
      assert.equal(
        (await loadSubnetHolders(store(), 7)).decline,
        "pool_totals_unproven",
      );
      assert.equal(
        (await loadChainHolders(store())).decline,
        "pool_totals_unproven",
      );
      assert.equal(
        (await loadNominatorPositions(store(), HOTKEY)).decline,
        "pool_totals_unproven",
      );
      const holdings = await topHoldersHoldings(environment());
      assert.deepEqual(holdings?.sorts, ["free_tao"]);
    },
  );

  test("a genuinely absent additive schema retains the existing reader during rollout", async () => {
    sqlite.exec("DROP TABLE alpha_snapshot_passes");
    const env = environment();
    const hot = await loadAccountPositionsFromStore(env, COLDKEY);
    const cold = await loadAccountPositionsColdTier(env, COLDKEY);
    assert.equal(hot?.total_stake_alpha, 900);
    assert.equal(cold?.total_stake_alpha, 900);
    assert.equal((await loadSubnetHolders(store(), 7)).rows[0].alpha, 900);
    assert.equal((await loadChainHolders(store())).rows[0].total_alpha, 900);
    const nominators = await loadNominatorPositions(store(), HOTKEY);
    assert.equal(nominators.rows[0].alpha, 900);
    const holdings = await topHoldersHoldings(environment());
    assert.equal(holdings?.cells.get(COLDKEY)?.delegated_tao, 1800);
  });

  test("a capture switching during a read declines instead of returning its older qualified quantities", async () => {
    for (const load of [
      () => loadAccountPositionsFromStore(environment(), COLDKEY),
      () => loadAccountPositionsColdTier(environment(), COLDKEY),
      () => loadSubnetHolders(store(), 7),
      () => loadChainHolders(store()),
      () => loadNominatorPositions(store(), HOTKEY),
      () => topHoldersHoldings(environment()),
    ]) {
      const resetSql =
        "DELETE FROM alpha_snapshot_passes; DELETE FROM alpha_snapshot_rows";
      sqlite.exec(resetSql);
      capture();
      position();
      let switched = false;
      afterRead = (sql) => {
        if (!switched && sql.includes("FROM alpha_snapshot_rows")) {
          switched = true;
          capture(479, STAMP + 1, 101);
        }
      };
      const result = await load();
      assert.ok(result);
      if ("position_count" in result)
        assert.equal(result.degraded?.reason, POSITIONS_DEGRADED_UNPRICEABLE);
      else if ("decline" in result)
        assert.equal(result.decline, "pool_totals_unproven");
      else assert.deepEqual(result.sorts, ["free_tao"]);
      afterRead = undefined;
    }
  });

  test("failed schema reads cannot be mistaken for rollout compatibility", async () => {
    const broken = {
      async first() {
        throw new Error("read failed");
      },
      async query<T>(): Promise<T[]> {
        throw new Error("legacy fallback forbidden");
      },
    };
    assert.equal((await loadSubnetHolders(broken, 7)).decline, "unavailable");
    assert.equal((await loadChainHolders(broken)).decline, "unavailable");
    assert.equal(
      (await loadNominatorPositions(broken, HOTKEY)).decline,
      "unavailable",
    );
    afterRead = (sql) => {
      if (sql.includes("sqlite_master")) throw new Error("read failed");
    };
    assert.equal(
      await loadAccountPositionsFromStore(environment(), COLDKEY),
      null,
    );
    const cold = await loadAccountPositionsColdTier(environment(), COLDKEY);
    assert.equal(cold, null);
    assert.equal(await topHoldersHoldings(environment()), null);
  });

  test("unrepresentable public fractions degrade without changing exact evidence", async () => {
    capture(454);
    for (const fraction of [null, 1.1]) {
      sqlite.exec("DELETE FROM alpha_snapshot_rows");
      position("2500000000", STAMP, fraction);
      const response = await handleRequest(
        new Request(
          `https://api.metagraph.sh/api/v1/accounts/${COLDKEY}/positions`,
        ),
        environment(),
        {},
      );
      assert.equal(response.status, 200);
      const body = await response.json();
      AccountPositionsArtifactSchema.parse(body.data);
      assert.equal(body.data.degraded.reason, POSITIONS_DEGRADED_UNPRICEABLE);
      const sql = "SELECT share_fraction FROM alpha_snapshot_rows";
      const statement = sqlite.prepare(sql);
      const row = statement.get();
      assert.equal(row?.share_fraction, fraction);
    }
  });

  test("a NULL exact quantity never falls through to legacy fraction pricing", () => {
    for (const alpha_rao of [null, "", "-1", "18446744073709551616"]) {
      const result = buildAccountPositions(
        [{ hotkey: HOTKEY, netuid: 7, share_fraction: 0.9, alpha_rao }],
        new Map([[`${HOTKEY}|7`, 1000]]),
        COLDKEY,
      );
      assert.equal(result.position_count, 0);
      assert.equal(result.degraded?.reason, POSITIONS_DEGRADED_UNPRICEABLE);
    }
  });
});

function projectionEnv(alphaStamp?: number): Env {
  const body = {
    schema_version: 1,
    sorts: ["free_tao", "delegated_tao", "total_tao", "net_flow_7d"],
    ...(alphaStamp === undefined ? {} : { alpha_captured_at: alphaStamp }),
    rows: [
      {
        ss58: COLDKEY,
        free_tao: 10,
        delegated_tao: 999,
        total_tao: 1009,
        net_flow_7d: 3,
        captured_at: STAMP,
      },
    ],
  };
  return {
    ...environment(),
    METAGRAPH_ARCHIVE: {
      async get(key: string) {
        assert.equal(key, TOP_HOLDERS_FLOW_PROJECTION_KEY);
        return {
          async json() {
            return body;
          },
        };
      },
    },
  } as unknown as Env;
}

describe("materialized top-holder quantities", () => {
  test("historical runtime479 NULL quantities invalidate a projection at the same capture", async () => {
    capture(479);
    position(null);
    const env = projectionEnv(STAMP);
    const total = await loadTopHoldersFlowTier(env, { sort: "total_tao" });
    assert.equal(total, null);
    const result = await loadTopHoldersFlowTier(env, { sort: "free_tao" });
    const accounts = result?.accounts as Record<string, unknown>[];
    assert.equal(accounts[0].delegated_tao, null);
  });

  test("self-stake arriving after a projection invalidates its quantities at the same canonical capture", async () => {
    capture();
    position();
    const env = projectionEnv(STAMP);
    assert.ok(await loadTopHoldersFlowTier(env, { sort: "total_tao" }));
    const sql =
      "INSERT INTO nominator_positions VALUES(?,?,?,?,?,'self-stake')";
    const statement = sqlite.prepare(sql);
    statement.run("other-coldkey", "other-hotkey", 8, 1, STAMP + 1);
    const total = await loadTopHoldersFlowTier(env, { sort: "total_tao" });
    assert.equal(total, null);
    const result = await loadTopHoldersFlowTier(env, { sort: "free_tao" });
    const accounts = result?.accounts as Record<string, unknown>[];
    assert.equal(accounts[0].delegated_tao, null);
  });
  test("a runtime479 capture removes older archived delegated and total cells on every sort", async () => {
    capture(479);
    const env = projectionEnv(STAMP - 1);
    const delegatedSort = { sort: "delegated_tao" };
    const delegated = await loadTopHoldersFlowTier(env, delegatedSort);
    assert.equal(delegated, null);
    const total = await loadTopHoldersFlowTier(env, { sort: "total_tao" });
    assert.equal(total, null);
    for (const sort of ["free_tao", "net_flow_7d"]) {
      const result = await loadTopHoldersFlowTier(env, { sort });
      const accounts = result?.accounts as Record<string, unknown>[];
      const row = accounts[0];
      assert.equal(row.free_tao, 10);
      assert.equal(row.net_flow_7d, 3);
      assert.equal(row.delegated_tao, null);
      assert.equal(row.total_tao, null);
    }
  });

  test("qualified runtime479 captures still require the artifact's own exact capture stamp", async () => {
    capture(479);
    for (const stamp of [undefined, STAMP - 1]) {
      const env = projectionEnv(stamp);
      const total = await loadTopHoldersFlowTier(env, { sort: "total_tao" });
      assert.equal(total, null);
    }
    const env = projectionEnv(STAMP);
    const result = await loadTopHoldersFlowTier(env, { sort: "total_tao" });
    const accounts = result?.accounts as Record<string, unknown>[];
    assert.equal(accounts[0].total_tao, 1009);
  });

  test("failed owner reads suppress archived quantities while free and flow cells remain usable", async () => {
    afterRead = () => {
      throw new Error("capture read failed");
    };
    const env = projectionEnv(STAMP);
    const total = await loadTopHoldersFlowTier(env, { sort: "total_tao" });
    assert.equal(total, null);
    const result = await loadTopHoldersFlowTier(env, { sort: "free_tao" });
    const accounts = result?.accounts as Record<string, unknown>[];
    assert.equal(accounts[0].delegated_tao, null);
  });
});

describe("public Alpha cache", () => {
  test("installed capture schema and failed selected-owner reads bypass obsolete public cache entries", async () => {
    const match = vi.fn(async () => Response.json({ obsolete: true }));
    const put = vi.fn(async () => {});
    vi.stubGlobal("caches", { default: { match, put } });
    resetDecodeWatermarkCache();
    const env = {
      ...environment(),
      METAGRAPH_CONTROL: {
        async get(key: string) {
          return key === "health:meta"
            ? { last_run_at: "2026-10-16T00:00:00.000Z" }
            : null;
        },
      },
      METAGRAPH_ARCHIVE: {
        async get(key: string) {
          return key === decodeWatermarkKey("mainnet")
            ? {
                async text() {
                  return JSON.stringify({ decoded_through: 100 });
                },
              }
            : null;
        },
      },
    } as unknown as Env;
    const paths = [
      "/api/v1/subnets/7/owner-capture",
      `/api/v1/accounts/${COLDKEY}/positions`,
      "/api/v1/accounts/top-holders",
    ];
    // Establish that these poisoned entries are otherwise eligible cache hits.
    for (const path of paths) {
      const response = await handleRequest(
        new Request(`https://api.metagraph.sh${path}`),
        { ...env, D1_STATE_TABLES: "neurons" },
        {},
      );
      assert.equal((await response.json()).obsolete, true);
    }
    assert.equal(match.mock.calls.length, paths.length);
    match.mockClear();
    capture(479);
    for (const failure of [false, true]) {
      if (failure)
        afterRead = () => {
          throw new Error("selected owner read failed");
        };
      for (const path of paths) {
        const response = await handleRequest(
          new Request(`https://api.metagraph.sh${path}`),
          env,
          {},
        );
        assert.equal(response.status, 200);
        assert.equal((await response.json()).obsolete, undefined);
      }
      assert.equal(match.mock.calls.length, 0);
      assert.equal(put.mock.calls.length, 0);
    }
  });
});
