// The positions basis for /validators/{hotkey}/nominators (#9617).
//
// THE POINT IS THAT FLOW CANNOT SEE A DORMANT DELEGATOR. The default basis
// derives the nominator list from StakeAdded/StakeRemoved over a 7d/30d/90d
// window, so someone who staked before the window and has not touched it since
// does not appear at all, and a long-standing nominator reads as smaller than
// they are because only in-window movement counts. That is the same defect
// #9557 fixed one level up, with the window doing the missing instead of a
// registered-only table.
//
// So the assertions here are about the two bases being DIFFERENT QUESTIONS
// rather than two qualities of one answer: the default must not move, `window`
// and `sort` must be REJECTED on the positions basis rather than silently
// ignored, and alpha must never be summed across subnets.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, test } from "vitest";
import {
  DEFAULT_NOMINATOR_BASIS,
  NOMINATOR_BASES,
  buildNominatorPositions,
  loadNominatorPositions,
  nominatorPositionsSql,
  type NominatorPositionsRead,
} from "../src/validator-nominator-positions.ts";
import { handleRequest } from "../workers/api.ts";
import type { Row } from "./row-type.ts";

const MIGRATIONS = [
  "0011_nominator_positions.sql",
  "0019_hotkey_alpha.sql",
  "0021_hotkey_alpha_passes.sql",
  "0022_nominator_positions_hotkey_netuid.sql",
].map((f) =>
  fs.readFileSync(path.join(process.cwd(), "migrations/d1", f), "utf8"),
);

const HOTKEY = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const OTHER_HOTKEY = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const PASS = 1_785_900_000_000;
const POSITIONS_AT = 1_785_953_674_407;
const ck = (n: number) => `5Coldkey${String(n).padStart(40, "0")}`;

let db: InstanceType<typeof DatabaseSync>;

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
      return { bind: (...v: unknown[]) => run(v), ...run([]) };
    },
  };
}
const env = () => ({ METAGRAPH_HEALTH_DB: d1() }) as unknown as Env;

function completePass() {
  db.prepare(
    `INSERT INTO hotkey_alpha_passes (captured_at, expected_rows, received_rows, completed_at)
     VALUES (?, 1, 1, ?)`,
  ).run(PASS, PASS + 1000);
}
function pool(hotkey: string, netuid: number, total: number) {
  db.prepare(
    `INSERT INTO hotkey_alpha (hotkey, netuid, total_alpha, captured_at) VALUES (?, ?, ?, ?)`,
  ).run(hotkey, netuid, total, PASS);
}
function position(
  coldkey: string,
  hotkey: string,
  netuid: number,
  frac: number,
) {
  db.prepare(
    `INSERT INTO nominator_positions (coldkey, hotkey, netuid, share_fraction, captured_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(coldkey, hotkey, netuid, frac, POSITIONS_AT);
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  for (const s of MIGRATIONS) db.exec(s);
});

describe("the positions basis reads the standing ledger", () => {
  test("returns every current delegator, per subnet", async () => {
    completePass();
    pool(HOTKEY, 1, 1000);
    pool(HOTKEY, 2, 500);
    position(ck(1), HOTKEY, 1, 0.5); // 500 alpha on netuid 1
    position(ck(1), HOTKEY, 2, 0.4); // 200 alpha on netuid 2
    position(ck(2), HOTKEY, 1, 0.25); // 250 alpha on netuid 1
    const card = buildNominatorPositions(
      await loadNominatorPositions(d1(), HOTKEY),
      HOTKEY,
    );
    assert.equal(card.basis, "positions");
    assert.equal(card.nominator_count, 2);
    const [first, second] = card.nominators as Row[];
    // Ranked by BREADTH first: ck(1) holds on two subnets.
    assert.equal(first.coldkey, ck(1));
    assert.equal(first.subnet_count, 2);
    assert.deepEqual(first.subnets, [
      { netuid: 1, alpha: 500 },
      { netuid: 2, alpha: 200 },
    ]);
    // The largest single holding carries its netuid, because an alpha figure
    // is only comparable within one subnet.
    assert.deepEqual(first.largest_position, { netuid: 1, alpha: 500 });
    assert.equal(second.coldkey, ck(2));
  });

  test("NEVER publishes a cross-subnet alpha total", async () => {
    // Each subnet's alpha is a different token; #8803 is what summing them
    // produced last time.
    completePass();
    pool(HOTKEY, 1, 1000);
    pool(HOTKEY, 2, 1000);
    position(ck(1), HOTKEY, 1, 0.5);
    position(ck(1), HOTKEY, 2, 0.5);
    const card = buildNominatorPositions(
      await loadNominatorPositions(d1(), HOTKEY),
      HOTKEY,
    );
    const nominator = (card.nominators as Row[])[0];
    assert.equal("total_alpha" in nominator, false);
    assert.equal("alpha" in nominator, false);
    assert.equal("total_alpha" in card, false);
  });

  test("filters to the requested hotkey", async () => {
    completePass();
    pool(HOTKEY, 1, 1000);
    pool(OTHER_HOTKEY, 1, 1000);
    position(ck(1), HOTKEY, 1, 0.5);
    position(ck(2), OTHER_HOTKEY, 1, 0.5);
    const card = buildNominatorPositions(
      await loadNominatorPositions(d1(), HOTKEY),
      HOTKEY,
    );
    assert.equal(card.nominator_count, 1);
    assert.equal((card.nominators as Row[])[0].coldkey, ck(1));
  });

  test("the SQL filters by hotkey and scopes to the proven pass", () => {
    const sql = nominatorPositionsSql(PASS);
    assert.match(sql, /WHERE np\.hotkey = \?/);
    assert.match(sql, new RegExp(`ha\\.captured_at = ${PASS}`));
    assert.match(sql, /GROUP BY np\.coldkey, np\.netuid/);
  });
});

describe("the positions basis declines rather than guessing", () => {
  test("no complete pass declines", async () => {
    pool(HOTKEY, 1, 1000);
    position(ck(1), HOTKEY, 1, 0.5);
    assert.equal(
      (await loadNominatorPositions(d1(), HOTKEY)).decline,
      "pool_totals_unproven",
    );
  });

  test("no binding and a failed read are unavailable", async () => {
    assert.equal(
      (await loadNominatorPositions(null, HOTKEY)).decline,
      "unavailable",
    );
    completePass();
    db.exec("DROP TABLE nominator_positions");
    assert.equal(
      (await loadNominatorPositions(d1(), HOTKEY)).decline,
      "unavailable",
    );
  });

  test("a missing passes table is unavailable", async () => {
    db.exec("DROP TABLE hotkey_alpha_passes");
    assert.equal(
      (await loadNominatorPositions(d1(), HOTKEY)).decline,
      "unavailable",
    );
  });

  test("a non-array result declines", async () => {
    completePass();
    const broken = {
      prepare(text: string) {
        const real = d1().prepare(text);
        return {
          bind: () => ({ all: async () => ({ results: undefined }) }),
          first: real.first,
        };
      },
    };
    assert.equal(
      (await loadNominatorPositions(broken as never, HOTKEY)).decline,
      "unavailable",
    );
  });

  test("a decline nulls the count rather than reporting zero delegators", () => {
    const card = buildNominatorPositions(
      { rows: [], capturedAt: null, decline: "pool_totals_unproven" },
      HOTKEY,
      { limit: 20 },
    );
    assert.deepEqual(card.nominators, []);
    assert.deepEqual(card.degraded, { reason: "pool_totals_unproven" });
    assert.equal(card.nominator_count, null);
    assert.equal(card.captured_at, null);
  });
});

describe("buildNominatorPositions edges", () => {
  const read = (rows: Row[]): NominatorPositionsRead => ({
    rows,
    capturedAt: PASS,
    decline: null,
  });

  test("an unreadable row is skipped without dropping its coldkey's others", () => {
    const card = buildNominatorPositions(
      read([
        {
          coldkey: ck(1),
          netuid: 1,
          alpha: 100,
          positions_captured_at: POSITIONS_AT,
        },
        { coldkey: ck(1), netuid: null, alpha: 50 },
        // Explicit nulls, which Number() would turn into 0 -- a netuid of 0 is
        // ROOT and an alpha of 0 is a real holding, so both must be dropped
        // rather than coerced.
        { coldkey: ck(1), netuid: 2, alpha: null },
        { coldkey: ck(1), netuid: 2, alpha: -5 },
        // A negative netuid is not a subnet index. Number() accepts it and
        // Number.isInteger agrees, so the >= 0 arm is what rejects it.
        { coldkey: ck(1), netuid: -1, alpha: 10 },
        { coldkey: ck(1), netuid: 1.5, alpha: 10 },
        { coldkey: 42, netuid: 3, alpha: 10 },
      ]),
      HOTKEY,
    );
    assert.equal(card.nominator_count, 1);
    assert.deepEqual((card.nominators as Row[])[0].subnets, [
      { netuid: 1, alpha: 100 },
    ]);
  });

  test("limit and offset page the delegator set without moving the count", () => {
    const rows = [1, 2, 3, 4, 5].map((n) => ({
      coldkey: ck(n),
      netuid: 1,
      alpha: 100 - n,
      positions_captured_at: POSITIONS_AT,
    }));
    const card = buildNominatorPositions(read(rows), HOTKEY, {
      limit: 2,
      offset: 1,
    });
    assert.equal((card.nominators as Row[]).length, 2);
    assert.equal(card.nominator_count, 5);
    assert.equal(card.offset, 1);
    assert.equal((card.nominators as Row[])[0].coldkey, ck(2));
  });

  test("an absent limit returns everything from the offset", () => {
    const rows = [1, 2, 3].map((n) => ({
      coldkey: ck(n),
      netuid: 1,
      alpha: 10 - n,
      positions_captured_at: POSITIONS_AT,
    }));
    const card = buildNominatorPositions(read(rows), HOTKEY);
    assert.equal((card.nominators as Row[]).length, 3);
    assert.equal(card.limit, null);
  });

  test("ties break on coldkey so the page is stable", () => {
    const card = buildNominatorPositions(
      read([
        {
          coldkey: ck(9),
          netuid: 1,
          alpha: 100,
          positions_captured_at: POSITIONS_AT,
        },
        {
          coldkey: ck(2),
          netuid: 1,
          alpha: 100,
          positions_captured_at: POSITIONS_AT,
        },
      ]),
      HOTKEY,
    );
    assert.deepEqual(
      (card.nominators as Row[]).map((n) => n.coldkey),
      [ck(2), ck(9)],
    );
  });

  test("carries the newest positions stamp and an out-of-range one is null", () => {
    const ok = buildNominatorPositions(
      read([
        {
          coldkey: ck(1),
          netuid: 1,
          alpha: 1,
          positions_captured_at: POSITIONS_AT,
        },
        {
          coldkey: ck(2),
          netuid: 1,
          alpha: 1,
          positions_captured_at: POSITIONS_AT + 5,
        },
      ]),
      HOTKEY,
    );
    assert.equal(
      ok.positions_captured_at,
      new Date(POSITIONS_AT + 5).toISOString(),
    );
    const bad = buildNominatorPositions(
      { rows: [], capturedAt: 1e300, decline: null },
      HOTKEY,
    );
    assert.equal(bad.captured_at, null);
    assert.equal(bad.positions_captured_at, null);
  });

  test("the basis vocabulary is what the contract publishes", () => {
    assert.deepEqual([...NOMINATOR_BASES], ["flow", "positions"]);
    assert.equal(DEFAULT_NOMINATOR_BASIS, "flow");
  });
});

describe("GET /api/v1/validators/{hotkey}/nominators?basis=", () => {
  const get = (p: string, e?: Env) =>
    handleRequest(
      new Request(`https://api.metagraph.sh${p}`),
      e ?? env(),
      {} as unknown as ExecutionContext,
    );
  const body = async (res: Response) => {
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    return ((await res.json()) as Row).data as Row;
  };

  test("serves the positions basis", async () => {
    completePass();
    pool(HOTKEY, 1, 1000);
    position(ck(1), HOTKEY, 1, 0.5);
    const data = await body(
      await get(`/api/v1/validators/${HOTKEY}/nominators?basis=positions`),
    );
    assert.equal(data.basis, "positions");
    assert.equal(data.nominator_count, 1);
  });

  test("the DEFAULT basis is unchanged", async () => {
    // The flow basis must keep answering as it always has: changing the default
    // would silently change what every existing caller's numbers mean.
    const data = await body(
      await get(`/api/v1/validators/${HOTKEY}/nominators`),
    );
    assert.equal(data.basis, undefined);
    assert.equal(Array.isArray(data.nominators), true);
  });

  test("window and sort are REJECTED on the positions basis", async () => {
    // Accepting them silently would imply the snapshot honoured them.
    for (const q of ["window=30d", "sort=net_staked"]) {
      const res = await get(
        `/api/v1/validators/${HOTKEY}/nominators?basis=positions&${q}`,
      );
      assert.equal(res.status, 400, `${q} must be rejected`);
    }
  });

  test("an unsupported basis is a 400", async () => {
    assert.equal(
      (await get(`/api/v1/validators/${HOTKEY}/nominators?basis=vibes`)).status,
      400,
    );
  });

  test("an over-ceiling limit is rejected on the positions basis", async () => {
    assert.equal(
      (
        await get(
          `/api/v1/validators/${HOTKEY}/nominators?basis=positions&limit=99999`,
        )
      ).status,
      400,
    );
  });

  test("a negative offset is rejected", async () => {
    assert.equal(
      (
        await get(
          `/api/v1/validators/${HOTKEY}/nominators?basis=positions&offset=-1`,
        )
      ).status,
      400,
    );
  });

  test("an unproven pool ledger declines with a stated reason", async () => {
    pool(HOTKEY, 1, 1000);
    position(ck(1), HOTKEY, 1, 0.5);
    const data = await body(
      await get(`/api/v1/validators/${HOTKEY}/nominators?basis=positions`),
    );
    assert.deepEqual(data.degraded, { reason: "pool_totals_unproven" });
    assert.equal(data.nominator_count, null);
  });

  test("no D1 binding declines rather than 500ing", async () => {
    const data = await body(
      await get(
        `/api/v1/validators/${HOTKEY}/nominators?basis=positions`,
        {} as Env,
      ),
    );
    assert.deepEqual(data.degraded, { reason: "unavailable" });
  });
});
