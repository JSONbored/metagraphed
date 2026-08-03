// The properties this two-tier reader has to hold: the lakehouse leg is the
// share-fraction ledger and nothing else, the stake leg is D1's live `neurons`
// (never the frozen lakehouse copy), the D1 IN-list respects the platform's
// 100-parameter ceiling, and every failure DECLINES rather than publishing a
// total that is quietly too small.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  D1_BIND_PARAM_CAP,
  POSITION_SCAN_CAP,
  loadAccountPositionsColdTier,
} from "../src/nominator-positions-cold-tier.ts";
import { R2_SQL_TOKEN_ENV } from "../src/r2-sql.ts";

const TOKEN = { [R2_SQL_TOKEN_ENV]: "cfut_test" };
const COLDKEY = "5Df7xwEPkZm4itD3PfSzHsV9extvnQpTFBiNCSgBCJtxEP9e";
const HOTKEY_A = "5FyVinYphF6JS5FZHzhMQffxtgbz1WxwUEBAxTRo9nABwb5g";
const HOTKEY_B = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

/** Stubs the R2 SQL leg and records the SQL it was handed. */
function sqlFetch(rows: unknown[]) {
  const queries: string[] = [];
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    queries.push(JSON.parse(String(init.body)).query);
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { rows } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return queries;
}

function failingFetch() {
  globalThis.fetch = (async () => {
    throw new Error("down");
  }) as unknown as typeof fetch;
}

/** A D1 stub that records every statement + binding it is handed, and answers
 * from a (hotkey, netuid) -> stake_tao table. `mode` forces the two failure
 * shapes the reader has to survive: a throw, and a malformed body. */
function d1Stub(
  stakes: { hotkey: string; netuid: number; stake_tao: number }[],
  mode: "ok" | "throw" | "malformed" = "ok",
) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async all() {
              calls.push({ sql, params });
              if (mode === "throw") throw new Error("d1 down");
              if (mode === "malformed") return { results: null };
              return {
                results: stakes.filter((row) =>
                  params.includes(row.hotkey),
                ) as unknown[],
              };
            },
          };
        },
      };
    },
  };
  return { calls, env: { ...TOKEN, METAGRAPH_HEALTH_DB: db } };
}

function positionRow(hotkey: string, netuid: number, fraction: number) {
  return {
    hotkey,
    netuid,
    share_fraction: fraction,
    captured_at: 1_785_634_702_670,
  };
}

describe("loadAccountPositionsColdTier", () => {
  test("prices the ledger's share fractions off D1's live neurons stake", async () => {
    const q = sqlFetch([
      positionRow(HOTKEY_A, 18, 0.5),
      positionRow(HOTKEY_B, 4, 0.25),
    ]);
    const { calls, env } = d1Stub([
      { hotkey: HOTKEY_A, netuid: 18, stake_tao: 100 },
      { hotkey: HOTKEY_B, netuid: 4, stake_tao: 40 },
    ]);
    const data = await loadAccountPositionsColdTier(env as never, COLDKEY);

    const s = q[0]!;
    assert.match(s, /FROM chain\.nominator_positions/);
    assert.match(s, new RegExp(`coldkey = '${COLDKEY}'`));
    assert.match(s, /hotkey, netuid, share_fraction, captured_at/);
    // The lakehouse holds a frozen `neurons` export too; pricing a live
    // position off it would quietly age every stake_tao in the payload.
    assert.doesNotMatch(s, /neurons/);
    assert.match(calls[0]!.sql, /FROM neurons WHERE hotkey IN \(\?, \?\)/);

    assert.equal(data!.position_count, 2);
    assert.equal(data!.total_stake_alpha, 60);
    assert.equal(data!.positions[0]!.stake_tao, 50);
    assert.equal(
      data!.captured_at,
      new Date(1_785_634_702_670).toISOString(),
      "captured_at comes from the ledger row, not the clock",
    );
  });

  test("keeps the alpha-denominated total name #8945 settled on", async () => {
    // The aggregate sums different subnets' alpha, so it is not a TAO value.
    // A *_tao name here would re-assert the arithmetic that rename undid.
    sqlFetch([positionRow(HOTKEY_A, 18, 1)]);
    const { env } = d1Stub([{ hotkey: HOTKEY_A, netuid: 18, stake_tao: 7 }]);
    const data = await loadAccountPositionsColdTier(env as never, COLDKEY);
    assert.equal(data!.total_stake_alpha, 7);
    assert.ok(
      !Object.hasOwn(data as object, "total_stake_tao"),
      "the alpha total must not reappear under a TAO name",
    );
  });

  test("chunks the D1 IN-list at the platform's 100-parameter ceiling", async () => {
    // D1 rejects a statement with more than 100 bound parameters even though
    // `wrangler d1 execute` accepts far more from the CLI -- so one IN-list
    // per hotkey-set would fail for exactly the coldkeys that matter most.
    const hotkeys = Array.from(
      { length: 250 },
      (_unused, i) => `${HOTKEY_A.slice(0, 44)}${String(i).padStart(4, "0")}`,
    );
    sqlFetch(hotkeys.map((hotkey, i) => positionRow(hotkey, i, 1)));
    const { calls, env } = d1Stub(
      hotkeys.map((hotkey, i) => ({ hotkey, netuid: i, stake_tao: 2 })),
    );
    const data = await loadAccountPositionsColdTier(env as never, COLDKEY);

    assert.equal(calls.length, 3, "250 hotkeys is three capped statements");
    for (const call of calls) {
      assert.ok(
        call.params.length <= D1_BIND_PARAM_CAP,
        `no statement may exceed ${D1_BIND_PARAM_CAP} bound parameters`,
      );
    }
    assert.equal(
      data!.position_count,
      250,
      "every chunk's rows reach the join map",
    );
  });

  test("declines a coldkey past the scan cap rather than under-reporting its total", async () => {
    // total_stake_alpha sums the whole set: a truncated scan would publish a
    // confident number that is quietly too small.
    const rows = Array.from({ length: POSITION_SCAN_CAP + 1 }, (_unused, i) =>
      positionRow(HOTKEY_A, i, 1),
    );
    const q = sqlFetch(rows);
    const { calls, env } = d1Stub([]);
    assert.equal(
      await loadAccountPositionsColdTier(env as never, COLDKEY),
      null,
    );
    assert.match(
      q[0]!,
      new RegExp(`LIMIT ${POSITION_SCAN_CAP + 1}`),
      "reads one row past the cap so the overflow is detectable",
    );
    assert.equal(calls.length, 0, "must not fan out to D1 after declining");
  });

  test("a coldkey with no positions answers an empty card without touching D1", async () => {
    sqlFetch([]);
    const { calls, env } = d1Stub([]);
    const data = await loadAccountPositionsColdTier(env as never, COLDKEY);
    assert.equal(data!.position_count, 0);
    assert.equal(data!.total_stake_alpha, 0);
    assert.equal(data!.ss58, COLDKEY);
    assert.equal(calls.length, 0, "no hotkeys means no statement at all");
  });

  test("declines an unusable address rather than scanning the whole ledger", async () => {
    const q = sqlFetch([]);
    assert.equal(
      await loadAccountPositionsColdTier(TOKEN as never, "not-an-ss58"),
      null,
    );
    assert.equal(q.length, 0, "must not issue a query at all");
  });

  test("declines when the lakehouse cannot answer", async () => {
    failingFetch();
    const { env } = d1Stub([]);
    assert.equal(
      await loadAccountPositionsColdTier(env as never, COLDKEY),
      null,
    );
  });

  test("declines when the stake leg is missing, throws, or answers malformed", async () => {
    // A partial stake map silently DROPS the positions it could not price,
    // and buildAccountPositions cannot tell that from a deregistered hotkey.
    sqlFetch([positionRow(HOTKEY_A, 18, 1)]);
    assert.equal(
      await loadAccountPositionsColdTier(TOKEN as never, COLDKEY),
      null,
      "no D1 binding is a decline, not an empty join",
    );

    sqlFetch([positionRow(HOTKEY_A, 18, 1)]);
    const thrown = d1Stub([], "throw");
    assert.equal(
      await loadAccountPositionsColdTier(thrown.env as never, COLDKEY),
      null,
    );

    sqlFetch([positionRow(HOTKEY_A, 18, 1)]);
    const malformed = d1Stub([], "malformed");
    assert.equal(
      await loadAccountPositionsColdTier(malformed.env as never, COLDKEY),
      null,
    );
  });

  test("excludes a position whose hotkey D1 has no stake row for", async () => {
    // The retired loader's own contract: a deregistered hotkey (or a snapshot
    // that has not caught up) is omitted, never reported at a fabricated zero.
    sqlFetch([positionRow(HOTKEY_A, 18, 1), positionRow(HOTKEY_B, 4, 1)]);
    const { env } = d1Stub([{ hotkey: HOTKEY_A, netuid: 18, stake_tao: 3 }]);
    const data = await loadAccountPositionsColdTier(env as never, COLDKEY);
    assert.equal(data!.position_count, 1);
    assert.equal(data!.positions[0]!.hotkey, HOTKEY_A);
  });
});
