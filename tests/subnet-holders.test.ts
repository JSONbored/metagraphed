// The per-subnet alpha holder leaderboard (src/subnet-holders.ts, #9557).
//
// Two properties carry the weight here, and both are about what the route must
// REFUSE to say.
//
// An empty `holders` array is the same shape whether nobody holds the subnet's
// alpha or the pool ledger has not finished loading, and only the first is a
// measurement. So every decline is asserted to carry BOTH the empty list and a
// `degraded.reason`, with null counts rather than zero ones -- a zero
// holder_count is a claim about the subnet, and this route may only make it when
// it actually counted.
//
// And the aggregates must describe the whole subnet rather than the returned
// page. `?limit=2` over five holders is the case that catches it: a top5_share
// computed over the two rows that came back is 1.0, well-formed and wrong. The
// SQL is therefore exercised against REAL SQLite through the real migrations
// rather than a string-matching double -- the nested LIMIT subqueries either
// rank the full set or they do not, and only a database can answer that.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, test } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsPlugin from "ajv-formats";
import { buildOpenApiArtifact } from "../src/contracts.ts";
import { loadOpenApiComponentSchemas } from "../scripts/openapi-components.ts";
import {
  HOLDER_CONCENTRATION_RANKS,
  ROOT_NETUID,
  SUBNET_HOLDERS_LIMIT_DEFAULT,
  SUBNET_HOLDERS_LIMIT_MAX,
  buildSubnetHolders,
  loadSubnetHolders,
  subnetHoldersAggregateSql,
  subnetHoldersRowsSql,
  type SubnetHoldersRead,
} from "../src/subnet-holders.ts";
import { handleRequest } from "../workers/api.ts";
import { MCP_TOOLS } from "../src/mcp-server.ts";
import type { Row } from "./row-type.ts";

const addFormats = addFormatsPlugin as unknown as (instance: Ajv2020) => void;

const MIGRATIONS = [
  "0011_nominator_positions.sql",
  "0019_hotkey_alpha.sql",
  "0021_hotkey_alpha_passes.sql",
  "0022_nominator_positions_hotkey_netuid.sql",
  "0023_nominator_positions_netuid.sql",
].map((file) =>
  fs.readFileSync(path.join(process.cwd(), "migrations/d1", file), "utf8"),
);

const NETUID = 74;
const PASS = 1_785_900_000_000;
const POSITIONS_AT = 1_785_953_674_407;

/** Deterministic, distinguishable ss58-shaped keys. */
const ck = (n: number) => `5Coldkey${String(n).padStart(40, "0")}`;
const hk = (n: number) => `5Hotkey0${String(n).padStart(40, "0")}`;

let db: InstanceType<typeof DatabaseSync>;

/** A D1 facade over real SQLite, carrying the three shapes this module uses:
 * bind().all(), bind().first(), and a bare prepare().first(). */
function d1() {
  return {
    prepare(text: string) {
      const run = (values: unknown[]) => ({
        async all() {
          return { results: db.prepare(text).all(...(values as never[])) };
        },
        async first() {
          return db.prepare(text).get(...(values as never[])) ?? null;
        },
      });
      return { bind: (...values: unknown[]) => run(values), ...run([]) };
    },
  };
}

function env(overrides: Record<string, unknown> = {}): Env {
  return {
    METAGRAPH_HEALTH_DB: d1(),
    ...overrides,
  } as unknown as Env;
}

function completePass(capturedAt = PASS) {
  db.prepare(
    `INSERT INTO hotkey_alpha_passes
       (captured_at, expected_rows, received_rows, completed_at)
     VALUES (?, ?, ?, ?)`,
  ).run(capturedAt, 3, 3, capturedAt + 1000);
}

function pool(hotkey: string, totalAlpha: number, capturedAt = PASS) {
  db.prepare(
    `INSERT INTO hotkey_alpha (hotkey, netuid, total_alpha, captured_at)
     VALUES (?, ?, ?, ?)`,
  ).run(hotkey, NETUID, totalAlpha, capturedAt);
}

function position(
  coldkey: string,
  hotkey: string,
  shareFraction: number,
  netuid = NETUID,
) {
  db.prepare(
    `INSERT INTO nominator_positions
       (coldkey, hotkey, netuid, share_fraction, captured_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(coldkey, hotkey, netuid, shareFraction, POSITIONS_AT);
}

/**
 * Five holders on one hotkey pool of 1,000 alpha, deliberately NOT in insert
 * order: 250 / 200 / 150 / 100 / 50. Any ranking that leans on row order rather
 * than on `alpha` gets a different answer.
 */
function fiveHolders() {
  completePass();
  pool(hk(1), 1000);
  position(ck(3), hk(1), 0.15);
  position(ck(1), hk(1), 0.25);
  position(ck(5), hk(1), 0.05);
  position(ck(2), hk(1), 0.2);
  position(ck(4), hk(1), 0.1);
}

async function assertValidComponent(
  componentName: string,
  data: unknown,
): Promise<void> {
  const generatedAt = "2026-08-05T12:00:00.000Z";
  const openapi = buildOpenApiArtifact(
    generatedAt,
    await loadOpenApiComponentSchemas(generatedAt),
  );
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile({
    $id: `https://metagraph.sh/test/${componentName}.json`,
    components: openapi.components,
    $ref: `#/components/schemas/${componentName}`,
  });
  assert.equal(validate(data), true, ajv.errorsText(validate.errors));
}

function get(path_: string, envOverride?: Env) {
  return handleRequest(
    new Request(`https://api.metagraph.sh${path_}`),
    envOverride ?? env(),
    {} as unknown as ExecutionContext,
  );
}

async function body(res: Response): Promise<Row> {
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  const parsed = (await res.json()) as Row;
  assert.equal(parsed.ok, true);
  return parsed.data as Row;
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  for (const schema of MIGRATIONS) db.exec(schema);
});

describe("loadSubnetHolders against real SQLite", () => {
  test("ranks coldkeys by alpha, valued against the proven pool pass", async () => {
    fiveHolders();
    const read = await loadSubnetHolders(d1(), NETUID, { limit: 3 });
    assert.equal(read.decline, null);
    assert.equal(read.capturedAt, PASS);
    assert.deepEqual(
      read.rows.map((r) => [r.coldkey, r.alpha]),
      [
        [ck(1), 250],
        [ck(2), 200],
        [ck(3), 150],
      ],
    );
    // The page is capped at 3; the aggregate still counts all five.
    assert.equal(read.aggregate?.holderCount, 5);
    assert.equal(read.aggregate?.totalAlpha, 750);
    assert.equal(read.aggregate?.positionsCapturedAt, POSITIONS_AT);
  });

  test("aggregates rank the FULL holder set, not the returned page", async () => {
    fiveHolders();
    // Two rows back, five holders ranked. top5 must be the whole 750, not the
    // 450 the page carries -- the defect a page-local aggregate would produce.
    const read = await loadSubnetHolders(d1(), NETUID, { limit: 2 });
    assert.equal(read.rows.length, 2);
    assert.equal(read.aggregate?.topAlpha.get(5), 750);
    assert.equal(read.aggregate?.topAlpha.get(10), 750);
    // Fewer holders than the rank: the sum is what exists, and the caller's
    // holder_count is what says the rank was not filled.
    assert.equal(read.aggregate?.topAlpha.get(20), 750);
  });

  test("counts distinct hotkeys per coldkey, registered or not", async () => {
    completePass();
    pool(hk(1), 100);
    pool(hk(2), 100);
    position(ck(1), hk(1), 0.5);
    position(ck(1), hk(2), 0.25);
    const read = await loadSubnetHolders(d1(), NETUID);
    assert.deepEqual(
      read.rows.map((r) => [r.coldkey, r.alpha, r.hotkey_count]),
      [[ck(1), 75, 2]],
    );
  });

  test("excludes positions on other subnets", async () => {
    completePass();
    pool(hk(1), 1000);
    position(ck(1), hk(1), 0.25);
    position(ck(2), hk(1), 0.5, NETUID + 1);
    const read = await loadSubnetHolders(d1(), NETUID);
    assert.deepEqual(
      read.rows.map((r) => r.coldkey),
      [ck(1)],
    );
    assert.equal(read.aggregate?.holderCount, 1);
  });

  test("excludes pool totals from a different pass stamp", async () => {
    completePass();
    pool(hk(1), 1000);
    // A newer, UNPROVEN pass for a second hotkey. Mixing stamps would value one
    // subnet's holders against totals read at two different blocks.
    pool(hk(2), 500, PASS + 5000);
    position(ck(1), hk(1), 0.25);
    position(ck(2), hk(2), 0.5);
    const read = await loadSubnetHolders(d1(), NETUID);
    assert.deepEqual(
      read.rows.map((r) => [r.coldkey, r.alpha]),
      [[ck(1), 250]],
    );
  });

  test("a subnet with a complete pass but no positions is a real empty ranking", async () => {
    completePass();
    const read = await loadSubnetHolders(d1(), NETUID);
    assert.equal(read.decline, null);
    assert.deepEqual(read.rows, []);
    // Measured: the pass completed and the count is a genuine zero.
    assert.equal(read.aggregate?.holderCount, 0);
    assert.equal(read.aggregate?.totalAlpha, null);
  });
});

describe("loadSubnetHolders declines", () => {
  test("root declines before the binding is even consulted", async () => {
    const read = await loadSubnetHolders(null, ROOT_NETUID);
    assert.equal(read.decline, "root_not_in_alpha_map");
    assert.deepEqual(read.rows, []);
    assert.equal(read.aggregate, null);
    assert.equal(read.capturedAt, null);
  });

  test("root declines with the same reason when D1 is healthy", async () => {
    completePass();
    const read = await loadSubnetHolders(d1(), ROOT_NETUID);
    assert.equal(read.decline, "root_not_in_alpha_map");
  });

  test("no binding is unavailable", async () => {
    assert.equal(
      (await loadSubnetHolders(undefined, NETUID)).decline,
      "unavailable",
    );
    assert.equal(
      (await loadSubnetHolders({} as never, NETUID)).decline,
      "unavailable",
    );
  });

  test("no complete pass declines rather than ranking a partial ledger", async () => {
    // Rows exist and would rank perfectly well -- that is exactly the danger.
    pool(hk(1), 1000);
    position(ck(1), hk(1), 0.25);
    const read = await loadSubnetHolders(d1(), NETUID);
    assert.equal(read.decline, "pool_totals_unproven");
    assert.deepEqual(read.rows, []);
  });

  test("an in-flight pass is not a complete one", async () => {
    db.prepare(
      `INSERT INTO hotkey_alpha_passes
         (captured_at, expected_rows, received_rows, completed_at)
       VALUES (?, ?, ?, NULL)`,
    ).run(PASS, 3, 1);
    pool(hk(1), 1000);
    position(ck(1), hk(1), 0.25);
    assert.equal(
      (await loadSubnetHolders(d1(), NETUID)).decline,
      "pool_totals_unproven",
    );
  });

  test("a missing passes table is unavailable, not a silent zero", async () => {
    db.exec("DROP TABLE hotkey_alpha_passes");
    assert.equal(
      (await loadSubnetHolders(d1(), NETUID)).decline,
      "unavailable",
    );
  });

  test("a failed row read declines rather than throwing", async () => {
    completePass();
    db.exec("DROP TABLE nominator_positions");
    assert.equal(
      (await loadSubnetHolders(d1(), NETUID)).decline,
      "unavailable",
    );
  });

  test("a non-array row result declines", async () => {
    completePass();
    const broken = {
      prepare(text: string) {
        const real = d1().prepare(text);
        return {
          bind: (...values: unknown[]) => ({
            all: async () => ({ results: undefined }),
            first: real.bind(...values).first,
          }),
          first: real.first,
        };
      },
    };
    assert.equal(
      (await loadSubnetHolders(broken as never, NETUID)).decline,
      "unavailable",
    );
  });
});

describe("the SQL states its own contract", () => {
  test("rows are scoped to the pass, ordered by alpha, and capped", () => {
    const sql = subnetHoldersRowsSql(PASS, 7);
    assert.match(sql, new RegExp(`ha\\.captured_at = ${PASS}`));
    assert.match(sql, /WHERE np\.netuid = \?/);
    assert.match(sql, /ORDER BY alpha DESC, coldkey ASC LIMIT 7/);
  });

  test("every concentration rank is a LIMIT over the full holder set", () => {
    const sql = subnetHoldersAggregateSql(PASS);
    for (const n of HOLDER_CONCENTRATION_RANKS) {
      assert.match(
        sql,
        new RegExp(
          `SELECT SUM\\(alpha\\) FROM \\(SELECT alpha FROM holder ORDER BY alpha DESC LIMIT ${n}\\)`,
        ),
      );
    }
    assert.match(sql, /SELECT COUNT\(\*\) FROM holder/);
  });

  test("the ceilings are the shared 20/100 pair", () => {
    assert.equal(SUBNET_HOLDERS_LIMIT_DEFAULT, 20);
    assert.equal(SUBNET_HOLDERS_LIMIT_MAX, 100);
  });
});

describe("buildSubnetHolders", () => {
  const read = (over: Partial<SubnetHoldersRead> = {}): SubnetHoldersRead => ({
    rows: [],
    aggregate: null,
    capturedAt: null,
    decline: null,
    ...over,
  });

  test("shares are taken over the subnet total, not the page", () => {
    const card = buildSubnetHolders(
      read({
        rows: [
          { coldkey: ck(1), alpha: 250, hotkey_count: 2 },
          { coldkey: ck(2), alpha: 200, hotkey_count: 1 },
        ],
        aggregate: {
          holderCount: 5,
          totalAlpha: 1000,
          topAlpha: new Map([
            [5, 750],
            [10, 750],
            [20, 750],
          ]),
          positionsCapturedAt: POSITIONS_AT,
        },
        capturedAt: PASS,
      }),
      NETUID,
      { limit: 2 },
    );
    const holders = card.holders as Row[];
    assert.equal(holders[0].share_of_total, 0.25);
    assert.equal(holders[1].share_of_total, 0.2);
    assert.equal(card.holder_count, 5);
    assert.deepEqual(card.concentration, {
      top5_share: 0.75,
      top10_share: 0.75,
      top20_share: 0.75,
    });
    assert.equal(card.captured_at, new Date(PASS).toISOString());
    assert.equal(
      card.positions_captured_at,
      new Date(POSITIONS_AT).toISOString(),
    );
    assert.equal(card.degraded, undefined);
  });

  test("a zero total yields null shares, never zero or Infinity", () => {
    const card = buildSubnetHolders(
      read({
        rows: [{ coldkey: ck(1), alpha: 0, hotkey_count: 1 }],
        aggregate: {
          holderCount: 1,
          totalAlpha: 0,
          topAlpha: new Map([
            [5, 0],
            [10, 0],
            [20, 0],
          ]),
          positionsCapturedAt: null,
        },
        capturedAt: PASS,
      }),
      NETUID,
    );
    assert.equal((card.holders as Row[])[0].share_of_total, null);
    assert.deepEqual(card.concentration, {
      top5_share: null,
      top10_share: null,
      top20_share: null,
    });
    // A measured zero total still serializes as 0, distinct from the null a
    // decline produces.
    assert.equal(card.total_alpha, 0);
    assert.equal(card.positions_captured_at, null);
  });

  test("unreadable rows are dropped rather than served as zeros", () => {
    const card = buildSubnetHolders(
      read({
        rows: [
          { coldkey: ck(1), alpha: 10, hotkey_count: 1 },
          { coldkey: 42, alpha: 10, hotkey_count: 1 },
          { coldkey: ck(2), alpha: null, hotkey_count: 1 },
          { coldkey: ck(3), alpha: -5, hotkey_count: 1 },
          { coldkey: ck(4), alpha: 5, hotkey_count: null },
        ],
        aggregate: {
          holderCount: 5,
          totalAlpha: 20,
          topAlpha: new Map([
            [5, 20],
            [10, 20],
            [20, 20],
          ]),
          positionsCapturedAt: POSITIONS_AT,
        },
        capturedAt: PASS,
      }),
      NETUID,
    );
    const holders = card.holders as Row[];
    assert.deepEqual(
      holders.map((h) => h.coldkey),
      [ck(1), ck(4)],
    );
    // A negative holding is a broken read, not a measurement, so it is dropped
    // rather than ranked below zero.
    assert.equal(holders[1].hotkey_count, null);
  });

  test.each([
    "pool_totals_unproven",
    "root_not_in_alpha_map",
    "unavailable",
  ] as const)("a %s decline nulls every count", (reason) => {
    const card = buildSubnetHolders(read({ decline: reason }), NETUID, {
      limit: 20,
    });
    assert.deepEqual(card.holders, []);
    assert.deepEqual(card.degraded, { reason });
    assert.equal(card.holder_count, null);
    assert.equal(card.total_alpha, null);
    assert.equal(card.captured_at, null);
    assert.equal(card.positions_captured_at, null);
    assert.deepEqual(card.concentration, {
      top5_share: null,
      top10_share: null,
      top20_share: null,
    });
    assert.equal(card.limit, 20);
  });

  test("an absent limit is null rather than a guessed default", () => {
    assert.equal(
      buildSubnetHolders(read({ decline: "unavailable" }), 1).limit,
      null,
    );
  });

  test("a missing aggregate nulls the counts without claiming a decline", () => {
    // Not reachable through loadSubnetHolders, which always pairs rows with an
    // aggregate -- but the builder is pure and separately callable, and the
    // failure mode if it guessed instead would be a zero holder_count on a
    // subnet it never counted.
    const card = buildSubnetHolders(
      read({ rows: [{ coldkey: ck(1), alpha: 10, hotkey_count: 1 }] }),
      NETUID,
    );
    assert.equal(card.holder_count, null);
    assert.equal(card.total_alpha, null);
    assert.equal(card.degraded, undefined);
    assert.deepEqual(card.concentration, {
      top5_share: null,
      top10_share: null,
      top20_share: null,
    });
    // With no total there is no share to state, so the row still serves its
    // measured alpha and declines the fraction.
    assert.equal((card.holders as Row[])[0].share_of_total, null);
  });

  test("a NaN capture stamp is null rather than an Invalid Date", () => {
    const card = buildSubnetHolders(read({ capturedAt: Number.NaN }), NETUID);
    assert.equal(card.captured_at, null);
  });

  test("a finite but out-of-range stamp is null, not a thrown RangeError", () => {
    // 1e300 passes every numeric guard and still puts `new Date()` outside the
    // +/-8.64e15ms it can represent. Serializing that would throw on
    // toISOString(), so the finiteness of the DATE is checked separately from
    // the finiteness of the number -- a corrupt captured_at must degrade to
    // null, not take the response down.
    const card = buildSubnetHolders(read({ capturedAt: 1e300 }), NETUID);
    assert.equal(card.captured_at, null);
  });

  test("a non-positive capture stamp is null, not 1970", () => {
    const card = buildSubnetHolders(
      read({
        rows: [],
        aggregate: {
          holderCount: 0,
          totalAlpha: null,
          topAlpha: new Map(),
          positionsCapturedAt: null,
        },
        capturedAt: 0,
      }),
      NETUID,
    );
    assert.equal(card.captured_at, null);
    assert.equal(card.total_alpha, null);
  });
});

describe("GET /api/v1/subnets/{netuid}/holders", () => {
  test("serves the ranking and matches the published component", async () => {
    fiveHolders();
    const data = await body(await get(`/api/v1/subnets/${NETUID}/holders`));
    assert.equal(data.netuid, NETUID);
    assert.equal(data.limit, SUBNET_HOLDERS_LIMIT_DEFAULT);
    assert.equal((data.holders as Row[]).length, 5);
    assert.equal(data.holder_count, 5);
    await assertValidComponent("SubnetHoldersArtifact", data);
  });

  test("?limit= slices the rows without moving the aggregates", async () => {
    fiveHolders();
    const data = await body(
      await get(`/api/v1/subnets/${NETUID}/holders?limit=2`),
    );
    assert.equal((data.holders as Row[]).length, 2);
    assert.equal(data.holder_count, 5);
    assert.equal(data.limit, 2);
    assert.equal((data.concentration as Row).top5_share, 1);
    await assertValidComponent("SubnetHoldersArtifact", data);
  });

  test("a decline is a 200 with a stated reason, never a 404", async () => {
    const data = await body(await get(`/api/v1/subnets/${NETUID}/holders`));
    assert.deepEqual(data.holders, []);
    assert.deepEqual(data.degraded, { reason: "pool_totals_unproven" });
    assert.equal(data.holder_count, null);
    await assertValidComponent("SubnetHoldersArtifact", data);
  });

  test("root declines with its own reason", async () => {
    completePass();
    const data = await body(await get(`/api/v1/subnets/0/holders`));
    assert.deepEqual(data.degraded, { reason: "root_not_in_alpha_map" });
    await assertValidComponent("SubnetHoldersArtifact", data);
  });

  test("an out-of-u16 netuid is a 400", async () => {
    const res = await get("/api/v1/subnets/70000/holders");
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as Row).ok, false);
  });

  test("an over-ceiling limit is rejected, not clamped", async () => {
    const res = await get(
      `/api/v1/subnets/${NETUID}/holders?limit=${SUBNET_HOLDERS_LIMIT_MAX + 1}`,
    );
    assert.equal(res.status, 400);
  });

  test("an unknown query parameter is rejected", async () => {
    const res = await get(`/api/v1/subnets/${NETUID}/holders?sort=alpha`);
    assert.equal(res.status, 400);
  });

  test("the path pattern is anchored, so a deeper path is not this route", async () => {
    fiveHolders();
    const res = await get(`/api/v1/subnets/${NETUID}/holders/extra`);
    assert.notEqual(res.status, 200);
  });

  test("no D1 binding declines rather than 500ing", async () => {
    const data = await body(
      await get(`/api/v1/subnets/${NETUID}/holders`, {} as Env),
    );
    assert.deepEqual(data.degraded, { reason: "unavailable" });
  });
});

describe("get_subnet_holders (MCP)", () => {
  const tool = () => {
    const found = MCP_TOOLS.find((t) => t.name === "get_subnet_holders");
    assert.ok(found, "get_subnet_holders is not registered");
    return found;
  };

  const call = (args: Row, envOverride?: Env) =>
    tool().handler(
      args as never,
      {
        env: envOverride ?? env(),
      } as never,
    ) as Promise<Row>;

  test("returns the same card the route serves", async () => {
    fiveHolders();
    const card = await call({ netuid: NETUID, limit: 3 });
    assert.equal(card.netuid, NETUID);
    assert.equal((card.holders as Row[]).length, 3);
    // Whole-subnet, exactly as over REST -- the two share one loader, so a model
    // and a client cannot be told different things about the same subnet.
    assert.equal(card.holder_count, 5);
    await assertValidComponent("SubnetHoldersArtifact", card);
  });

  test("an absent limit uses the shared default", async () => {
    fiveHolders();
    const card = await call({ netuid: NETUID });
    assert.equal(card.limit, SUBNET_HOLDERS_LIMIT_DEFAULT);
  });

  test("an over-ceiling limit is clamped rather than erroring", async () => {
    fiveHolders();
    const card = await call({
      netuid: NETUID,
      limit: SUBNET_HOLDERS_LIMIT_MAX + 50,
    });
    assert.equal(card.limit, SUBNET_HOLDERS_LIMIT_MAX);
  });

  test("an out-of-u16 netuid is a tool error", async () => {
    await assert.rejects(() => call({ netuid: 70000 }));
  });

  test("declines carry the reason a model must read before concluding zero", async () => {
    const card = await call({ netuid: NETUID });
    assert.deepEqual(card.holders, []);
    assert.deepEqual(card.degraded, { reason: "pool_totals_unproven" });
    assert.equal(card.holder_count, null);
  });

  test("the tool declares an output schema", () => {
    const def = tool();
    assert.equal(typeof def.description, "string");
    assert.match(def.description, /degraded\.reason/);
  });
});
