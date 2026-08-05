// The hotkey-alpha sync lane (#9502), exercised END TO END against a REAL
// SQLite database through the real Worker fetch handler -- same harness and
// rationale as tests/data-api-account-balances-d1.test.ts.
//
// This table is the input `delegated_tao` could not be computed without. A
// coldkey's `nominator_positions.share_fraction` is a dimensionless slice of a
// (hotkey, netuid) alpha POOL, and the only stake figure in D1 --
// `neurons.stake_tao` -- exists solely for hotkeys registered on that exact
// subnet: 512 of the 13,724 pairs the positions actually name, so 22.8% of
// position rows priced. Recomputing the leaderboard from that join ranks an
// account the frozen snapshot puts at 81,185 TAO at 0, which is why the column
// waited for this rather than shipping a per-row label on a ranking.
//
// What matters here is the write CONTRACT, and it differs from the balances
// lane in exactly one structural way: the key is COMPOSITE. A hotkey holds a
// separate pool on every subnet it is staked to, so (hotkey, netuid) is the
// identity and a same-hotkey/different-netuid row must INSERT rather than
// overwrite. The sibling Alpha scan is ~762,577 entries, past any single
// request body, so a pass arrives across many requests -- which is why there is
// no prune and why the captured_at guard, not request ordering, is what keeps a
// replay safe.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, test } from "vitest";
import type { Row } from "./row-type.ts";

const { default: worker } = await import("../workers/data-api.ts");

const SCHEMA = fs.readFileSync(
  path.join(process.cwd(), "migrations/d1/0019_hotkey_alpha.sql"),
  "utf8",
);

const PATH = "/api/v1/internal/hotkey-alpha-sync";
const SECRET = "test-hotkey-alpha-sync-secret";
const HOTKEY = "5FyVinYphF6JS5FZHzhMQffxtgbz1WxwUEBAxTRo9nABwb5g";
const HOTKEY_B = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

let db: InstanceType<typeof DatabaseSync>;

function d1() {
  return {
    prepare(text: string) {
      return {
        bind(...values: unknown[]) {
          return {
            text,
            values,
            async all() {
              return { results: db.prepare(text).all(...(values as never[])) };
            },
          };
        },
      };
    },
    async batch(statements: { text: string; values: unknown[] }[]) {
      db.exec("BEGIN");
      try {
        const results = statements.map((statement) => ({
          results: db
            .prepare(statement.text)
            .all(...(statement.values as never[])),
        }));
        db.exec("COMMIT");
        return results;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

function env(overrides: Record<string, unknown> = {}): Env {
  return {
    METAGRAPH_HEALTH_DB: d1(),
    HOTKEY_ALPHA_SYNC_SECRET: SECRET,
    ...overrides,
  } as unknown as Env;
}

function post(body: unknown, token: string | null = SECRET, envOverride?: Env) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (token !== null) headers["x-hotkey-alpha-sync-token"] = token;
  return worker.fetch(
    new Request(`https://d${PATH}`, {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    envOverride ?? env(),
    {} as unknown as ExecutionContext,
  );
}

function alphaRow(overrides: Row = {}): Row {
  return {
    hotkey: HOTKEY,
    netuid: 7,
    total_alpha: 1234.5,
    captured_at: 1_780_000_000_000,
    ...overrides,
  };
}

const rows = () =>
  db
    .prepare("SELECT * FROM hotkey_alpha ORDER BY hotkey, netuid")
    .all() as Row[];

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
});

describe("POST /api/v1/internal/hotkey-alpha-sync", () => {
  test("writes a batch to D1 and reports what it did", async () => {
    const response = await post({
      rows: [alphaRow(), alphaRow({ hotkey: HOTKEY_B, total_alpha: 0 })],
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      hotkey_alpha_written: 2,
      stores: ["d1"],
      d1_statements: 1,
    });
    assert.equal(rows().length, 2);
    // A zero pool IS stored. The producer skips an unread pool, so a zero that
    // arrives is a measured emptiness, not a placeholder -- the distinction
    // the NOT NULL column exists to preserve.
    assert.equal(rows()[1]!.total_alpha, 0);
  });

  test("the same hotkey on two subnets is two rows, not an overwrite", async () => {
    // The whole reason this table exists: a delegate accrues alpha on every
    // subnet it is staked to. A single-column key would collapse those pools
    // into one and misprice every position on all but the last-written subnet.
    await post({
      rows: [
        alphaRow({ netuid: 7, total_alpha: 100 }),
        alphaRow({ netuid: 83, total_alpha: 250 }),
      ],
    });
    assert.equal(rows().length, 2);
    assert.deepEqual(
      rows().map((r) => [r.netuid, r.total_alpha]),
      [
        [7, 100],
        [83, 250],
      ],
    );
  });

  test("a newer capture updates in place; an older one is ignored", async () => {
    // Real epoch-ms throughout: validSyncCapturedAt rejects a toy value like
    // 2000 outright, which is the guard #9382 exists for -- a seconds-scale
    // number read as ms lands in 1970 and pins the row permanently.
    const older = 1_780_000_000_000;
    const newer = 1_781_000_000_000;
    await post({ rows: [alphaRow({ total_alpha: 100, captured_at: older })] });
    await post({ rows: [alphaRow({ total_alpha: 300, captured_at: newer })] });
    assert.equal(rows()[0]!.total_alpha, 300);
    // A pass arrives across many requests and the producer re-sends on
    // failure, so a replayed or out-of-order batch must be a no-op rather than
    // a regression to an older pool size.
    await post({ rows: [alphaRow({ total_alpha: 999, captured_at: older })] });
    assert.equal(rows()[0]!.total_alpha, 300);
    assert.equal(rows()[0]!.captured_at, newer);
  });

  test("accepts a bare array as well as {rows:[...]}", async () => {
    const response = await post([alphaRow()]);
    assert.equal(response.status, 200);
    assert.equal(rows().length, 1);
  });

  test("rejects a missing or wrong token before reading the body", async () => {
    assert.equal((await post({ rows: [alphaRow()] }, null)).status, 401);
    assert.equal((await post({ rows: [alphaRow()] }, "wrong")).status, 401);
    assert.equal(rows().length, 0);
  });

  test("503s when the route is not provisioned", async () => {
    const response = await post(
      { rows: [alphaRow()] },
      SECRET,
      env({ HOTKEY_ALPHA_SYNC_SECRET: undefined }),
    );
    assert.equal(response.status, 503);
  });

  test("400s on a body that is not JSON or not a row list", async () => {
    assert.equal((await post("not json")).status, 400);
    assert.equal((await post({ nope: 1 })).status, 400);
    assert.equal((await post({ rows: [] })).status, 400);
  });

  test("rejects a row carrying a key outside the writer's column list", async () => {
    // An unknown key means the producer and the writer disagree about the
    // shape; accepting it would silently drop the field.
    const response = await post({ rows: [alphaRow({ extra: 1 })] });
    assert.equal(response.status, 400);
    assert.equal(rows().length, 0);
  });

  test("rejects a negative, non-finite or non-numeric alpha", async () => {
    // A NaN or Infinity arriving as null would bind as NULL against a NOT NULL
    // column and fail the whole batch at the database rather than here.
    for (const bad of [-1, "1234.5", null, undefined]) {
      const response = await post({ rows: [alphaRow({ total_alpha: bad })] });
      assert.equal(response.status, 400, String(bad));
    }
    assert.equal(
      (
        await post(
          `{"rows":[{"hotkey":"${HOTKEY}","netuid":7,"total_alpha":1e999,"captured_at":1780000000000}]}`,
        )
      ).status,
      400,
      "Infinity",
    );
    assert.equal(rows().length, 0);
  });

  test("rejects a junk netuid rather than creating a parallel row", async () => {
    // netuid is half the primary key, so a non-integer or negative value
    // silently creates a second row for the same pool instead of updating it.
    for (const bad of [-1, 1.5, "7", null]) {
      const response = await post({ rows: [alphaRow({ netuid: bad })] });
      assert.equal(response.status, 400, String(bad));
    }
    assert.equal(rows().length, 0);
  });

  test("rejects an empty or oversized hotkey", async () => {
    assert.equal(
      (await post({ rows: [alphaRow({ hotkey: "" })] })).status,
      400,
    );
    assert.equal(
      (await post({ rows: [alphaRow({ hotkey: "5".repeat(200) })] })).status,
      400,
    );
    assert.equal(rows().length, 0);
  });

  test("rejects a captured_at the staleness guard cannot trust", async () => {
    for (const bad of [0, -1, "1780000000000", null]) {
      const response = await post({ rows: [alphaRow({ captured_at: bad })] });
      assert.equal(response.status, 400, String(bad));
    }
    assert.equal(rows().length, 0);
  });

  test("503s when D1 is unbound, and only AFTER validating the body", async () => {
    // A malformed body is a 400 whether or not a store happens to be bound.
    const unbound = env({ METAGRAPH_HEALTH_DB: undefined });
    assert.equal((await post({ nope: 1 }, SECRET, unbound)).status, 400);
    assert.equal(
      (await post({ rows: [alphaRow()] }, SECRET, unbound)).status,
      503,
    );
  });

  test("502s when the D1 write throws", async () => {
    const exploding = env({
      METAGRAPH_HEALTH_DB: {
        prepare: () => ({ bind: () => ({}) }),
        batch: async () => {
          throw new Error("d1 exploded");
        },
      },
    });
    const response = await post({ rows: [alphaRow()] }, SECRET, exploding);
    assert.equal(response.status, 502);
  });
});
