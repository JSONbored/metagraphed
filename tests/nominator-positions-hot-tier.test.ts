// The D1 hot leg for /accounts/{ss58}/positions (#9273) and the honest-zero
// primitives it shares with the lakehouse leg.
//
// The properties that matter: the cutover is a property of the DATA (an empty
// ledger declines so the lakehouse still answers), a coldkey with no rows in a
// POPULATED ledger is a real live zero and carries the ledger's stamp rather
// than a null, the IN-list respects D1's 100-bound-parameter binding limit,
// and every failure declines rather than publishing a total that is quietly
// too small.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { loadAccountPositionsD1 } from "../src/nominator-positions-hot-tier.ts";
import { POSITION_SCAN_CAP } from "../src/nominator-positions-cold-tier.ts";
import {
  POSITIONS_DEGRADED_SNAPSHOT_PREDATES_ACTIVITY,
  POSITIONS_DEGRADED_TIER_UNAVAILABLE,
  annotatePositionsSnapshot,
  buildAccountPositions,
  unavailableAccountPositions,
} from "../src/account-nominator-positions.ts";

const COLDKEY = "5Df7xwEPkZm4itD3PfSzHsV9extvnQpTFBiNCSgBCJtxEP9e";
const HOTKEY_A = "5FyVinYphF6JS5FZHzhMQffxtgbz1WxwUEBAxTRo9nABwb5g";
const HOTKEY_B = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";
const CAPTURED_AT = 1_785_634_702_670;

interface Stake {
  hotkey: string;
  netuid: number;
  stake_tao: number;
}

/**
 * A D1 stub that answers the three statements this reader issues: the
 * coldkey's position rows, the ledger's MAX(captured_at), and the chunked
 * `neurons` IN-lists. `mode` forces the failure shapes.
 */
function d1Stub(
  positions: Record<string, unknown>[],
  ledgerCapturedAt: number | null,
  stakes: Stake[],
  mode: "ok" | "throw" | "malformed" | "stake-throw" = "ok",
) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      const isLedger = sql.includes("MAX(captured_at)");
      return {
        bind(...params: unknown[]) {
          calls.push({ sql, params });
          return {
            async all() {
              if (sql.includes("FROM neurons")) {
                if (mode === "stake-throw") throw new Error("neurons down");
                return {
                  results: stakes.filter((row) => params.includes(row.hotkey)),
                };
              }
              if (mode === "throw") throw new Error("d1 down");
              if (mode === "malformed") return { results: null };
              return { results: positions };
            },
          };
        },
        async first() {
          calls.push({ sql, params: [] });
          if (!isLedger) throw new Error("unexpected first()");
          if (mode === "throw") throw new Error("d1 down");
          return { latest: ledgerCapturedAt };
        },
      };
    },
  };
  return { calls, env: { METAGRAPH_HEALTH_DB: db } };
}

function positionRow(hotkey: string, netuid: number, fraction: number) {
  return {
    hotkey,
    netuid,
    share_fraction: fraction,
    captured_at: CAPTURED_AT,
  };
}

describe("loadAccountPositionsD1", () => {
  test("prices the ledger's share fractions off the live neurons table", async () => {
    const { calls, env } = d1Stub(
      [positionRow(HOTKEY_A, 18, 0.5), positionRow(HOTKEY_B, 4, 0.25)],
      CAPTURED_AT,
      [
        { hotkey: HOTKEY_A, netuid: 18, stake_tao: 100 },
        { hotkey: HOTKEY_B, netuid: 4, stake_tao: 40 },
      ],
    );
    const data = await loadAccountPositionsD1(env as never, COLDKEY);

    const positionsSql = calls.find((c) =>
      c.sql.includes("FROM nominator_positions WHERE coldkey"),
    )!;
    assert.match(
      positionsSql.sql,
      /hotkey, netuid, share_fraction, captured_at/,
    );
    assert.deepEqual(
      positionsSql.params,
      [COLDKEY, POSITION_SCAN_CAP + 1],
      "the address is BOUND, never interpolated, and the scan reads one row past the cap",
    );

    assert.equal(data!.position_count, 2);
    assert.equal(data!.total_stake_alpha, 60);
    assert.equal(data!.positions[0]!.stake_tao, 50);
    assert.equal(data!.captured_at, new Date(CAPTURED_AT).toISOString());
    assert.ok(!("degraded" in data!), "a real answer carries no degraded flag");
  });

  test("an EMPTY ledger declines so the lakehouse still answers", async () => {
    // The cutover is a property of the data, not of a deploy: until the
    // revived lane posts anything, this leg must get out of the way.
    const { env } = d1Stub([], null, []);
    assert.equal(await loadAccountPositionsD1(env as never, COLDKEY), null);
  });

  test("a rowless coldkey in a POPULATED ledger is a live zero with a real stamp", async () => {
    // This is the whole point: "the lane has not run" and "this account holds
    // nothing" are different answers, and the old payload could not tell them
    // apart because both were `position_count: 0, captured_at: null`.
    const { calls, env } = d1Stub([], CAPTURED_AT, []);
    const data = await loadAccountPositionsD1(env as never, COLDKEY);
    assert.equal(data!.position_count, 0);
    assert.equal(data!.total_stake_alpha, 0);
    assert.equal(
      data!.captured_at,
      new Date(CAPTURED_AT).toISOString(),
      "the ledger's own stamp, so the age of the zero is visible",
    );
    assert.ok(
      !("degraded" in data!),
      "a live lane's zero is a measurement, not a decline",
    );
    assert.equal(
      calls.filter((c) => c.sql.includes("FROM neurons")).length,
      0,
      "no hotkeys means no fan-out",
    );
  });

  test("chunks the neurons IN-list at D1's 100-bound-parameter binding limit", async () => {
    // The binding rejects a statement over 100 parameters even though
    // `wrangler d1 execute` accepts 1,200 from the CLI. The limit is asserted
    // rather than a count, because the count grows with the network.
    const hotkeys = Array.from(
      { length: 250 },
      (_unused, i) => `${HOTKEY_A.slice(0, 44)}${String(i).padStart(4, "0")}`,
    );
    const { calls, env } = d1Stub(
      hotkeys.map((hotkey, i) => positionRow(hotkey, i, 1)),
      CAPTURED_AT,
      hotkeys.map((hotkey, i) => ({ hotkey, netuid: i, stake_tao: 2 })),
    );
    const data = await loadAccountPositionsD1(env as never, COLDKEY);
    const stakeCalls = calls.filter((c) => c.sql.includes("FROM neurons"));
    assert.equal(stakeCalls.length, 3);
    for (const call of stakeCalls) assert.ok(call.params.length <= 100);
    assert.equal(data!.position_count, 250);
  });

  test("declines a coldkey past the scan cap rather than under-reporting its total", async () => {
    const { env } = d1Stub(
      Array.from({ length: POSITION_SCAN_CAP + 1 }, (_unused, i) =>
        positionRow(HOTKEY_A, i, 1),
      ),
      CAPTURED_AT,
      [],
    );
    assert.equal(await loadAccountPositionsD1(env as never, COLDKEY), null);
  });

  test("declines with no binding, a throwing read, a malformed result, or a failed stake leg", async () => {
    assert.equal(await loadAccountPositionsD1({} as never, COLDKEY), null);
    assert.equal(await loadAccountPositionsD1(null, COLDKEY), null);
    assert.equal(
      await loadAccountPositionsD1(
        { METAGRAPH_HEALTH_DB: {} } as never,
        COLDKEY,
      ),
      null,
    );

    const thrown = d1Stub([], CAPTURED_AT, [], "throw");
    assert.equal(
      await loadAccountPositionsD1(thrown.env as never, COLDKEY),
      null,
    );

    const malformed = d1Stub([], CAPTURED_AT, [], "malformed");
    assert.equal(
      await loadAccountPositionsD1(malformed.env as never, COLDKEY),
      null,
    );

    // A partial stake map silently DROPS the positions it could not price,
    // and buildAccountPositions cannot tell that from a deregistered hotkey.
    const stakeDown = d1Stub(
      [positionRow(HOTKEY_A, 18, 1)],
      CAPTURED_AT,
      [],
      "stake-throw",
    );
    assert.equal(
      await loadAccountPositionsD1(stakeDown.env as never, COLDKEY),
      null,
    );
  });

  test("a non-numeric ledger stamp is treated as an empty ledger", async () => {
    const { env } = d1Stub([], "2026-08-02" as never, []);
    assert.equal(await loadAccountPositionsD1(env as never, COLDKEY), null);
  });
});

describe("the honest-zero primitives", () => {
  test("unavailableAccountPositions labels a zero that is really a read failure", () => {
    const data = unavailableAccountPositions(COLDKEY);
    assert.equal(data.ss58, COLDKEY);
    assert.equal(data.position_count, 0);
    assert.equal(data.total_stake_alpha, 0);
    assert.deepEqual(data.degraded, {
      reason: POSITIONS_DEGRADED_TIER_UNAVAILABLE,
      snapshot_captured_at: null,
      latest_stake_event_at: null,
    });
  });

  test("a non-empty result is returned untouched", () => {
    const built = buildAccountPositions(
      [positionRow(HOTKEY_A, 18, 1)],
      new Map([[`${HOTKEY_A}|18`, 5]]),
      COLDKEY,
    );
    const annotated = annotatePositionsSnapshot(built, {
      snapshotCapturedAtMs: 1,
      latestStakeEventMs: Number.MAX_SAFE_INTEGER,
    });
    assert.equal(
      annotated,
      built,
      "same object, no snapshot fields grafted on",
    );
    assert.ok(!("degraded" in annotated));
  });

  test("a zero gains the LEDGER's stamp even with no rows to derive one from", () => {
    const annotated = annotatePositionsSnapshot(
      buildAccountPositions([], new Map(), COLDKEY),
      { snapshotCapturedAtMs: CAPTURED_AT, latestStakeEventMs: null },
    );
    assert.equal(annotated.captured_at, new Date(CAPTURED_AT).toISOString());
    assert.ok(
      !("degraded" in annotated),
      "an uncontradicted zero is still a measurement",
    );
  });

  test("a stake event NEWER than the snapshot contradicts the zero", () => {
    // The #9273 failure in one assertion: four of five coldkeys sampled from a
    // live nominators response were provably delegating and got a confident
    // `positions: 0` from a ledger frozen before they started.
    const stakeAt = CAPTURED_AT + 60_000;
    const annotated = annotatePositionsSnapshot(
      buildAccountPositions([], new Map(), COLDKEY),
      { snapshotCapturedAtMs: CAPTURED_AT, latestStakeEventMs: stakeAt },
    );
    assert.deepEqual(annotated.degraded, {
      reason: POSITIONS_DEGRADED_SNAPSHOT_PREDATES_ACTIVITY,
      snapshot_captured_at: new Date(CAPTURED_AT).toISOString(),
      latest_stake_event_at: new Date(stakeAt).toISOString(),
    });
  });

  test("a stake event OLDER than the snapshot leaves the zero alone", () => {
    // The account stopped delegating before the snapshot; the zero is real.
    const annotated = annotatePositionsSnapshot(
      buildAccountPositions([], new Map(), COLDKEY),
      {
        snapshotCapturedAtMs: CAPTURED_AT,
        latestStakeEventMs: CAPTURED_AT - 60_000,
      },
    );
    assert.ok(!("degraded" in annotated));
  });

  test("an unstamped ledger cannot rescue a zero a stake event contradicts", () => {
    const annotated = annotatePositionsSnapshot(
      buildAccountPositions([], new Map(), COLDKEY),
      { snapshotCapturedAtMs: null, latestStakeEventMs: CAPTURED_AT },
    );
    assert.equal(annotated.captured_at, null);
    assert.equal(
      annotated.degraded!.reason,
      POSITIONS_DEGRADED_SNAPSHOT_PREDATES_ACTIVITY,
    );
    assert.equal(annotated.degraded!.snapshot_captured_at, null);
  });

  test("an existing captured_at is never overwritten by the ledger stamp", () => {
    // A result whose own rows were all dropped by the stake join still knows
    // when it was captured; the ledger stamp only FILLS a null.
    const zeroWithStamp = {
      ...buildAccountPositions([], new Map(), COLDKEY),
      captured_at: "2020-01-01T00:00:00.000Z",
    };
    const annotated = annotatePositionsSnapshot(zeroWithStamp, {
      snapshotCapturedAtMs: CAPTURED_AT,
      latestStakeEventMs: null,
    });
    assert.equal(annotated.captured_at, "2020-01-01T00:00:00.000Z");
  });
});
