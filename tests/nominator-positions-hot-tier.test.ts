// The selected ledger preserves relationships and distinguishes unavailable,
// empty and populated sources. Neuron weights cannot establish holdings;
// exact Alpha requires a complete runtime-qualified pass and original evidence.
import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import { pgMockEnv } from "./helpers/pg-mock.ts";

// One store since #10179, reached through `new Client(...)` inside
// src/read-store.ts -- which this reader cannot be handed, because it takes
// only `(env, ss58)`. See tests/helpers/pg-mock.ts for why the seam is a module
// mock and why the controller is built inside vi.hoisted.
const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);

import { loadAccountPositionsFromStore } from "../src/nominator-positions-hot-tier.ts";
import {
  POSITION_SCAN_CAP,
  neuronStakeByHotkeys,
} from "../src/nominator-positions-cold-tier.ts";
import {
  syntheticAlphaCapture,
  syntheticAlphaPosition,
} from "./helpers/alpha-quantity-fixture.ts";
import {
  alphaQuantityProvenance,
  type AlphaQuantityCapture,
} from "../src/alpha-quantity.ts";
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

/** Explicit SQL dispatch keeps snapshot identity separate from relationship
 * rows and legacy neuron observations, including read-failure shapes. */
function d1Stub(
  positions: Record<string, unknown>[],
  ledgerCapturedAt: number | null,
  stakes: Stake[],
  mode: "ok" | "throw" | "malformed" | "stake-throw" | "capture-throw" = "ok",
  capture: AlphaQuantityCapture | null = null,
) {
  const calls: { sql: string; params: unknown[] }[] = [];
  pg.control.queries.length = 0;
  pg.control.answers = [];
  pg.control.rows = null;
  pg.control.failNext = null;
  pg.control.onQuery = ({ text, values }) => {
    calls.push({ sql: text, params: values });
    pg.control.failNext = null;
    if (text.includes("FROM neurons")) {
      if (mode === "stake-throw") {
        pg.control.failNext = new Error("neurons down");
        return;
      }
      pg.control.rows = stakes.filter((row) => values.includes(row.hotkey));
      return;
    }
    if (mode === "throw") {
      pg.control.failNext = new Error("store down");
      return;
    }
    if (text.includes("FROM alpha_snapshot_passes")) {
      if (mode === "capture-throw") {
        pg.control.failNext = new Error("metadata unavailable");
        return;
      }
      pg.control.rows = capture ? [capture] : [];
      return;
    }
    if (text.includes("MAX(captured_at)")) {
      pg.control.rows = [{ latest: ledgerCapturedAt }];
      return;
    }
    // A store handing back something that is not a row array. readStore cannot
    // manufacture one, so it is injected here -- the guard it trips is what
    // stops `results.length` becoming a TypeError inside a decline path.
    pg.control.rows =
      mode === "malformed" ? ("not-an-array" as never) : positions;
  };
  // No D1 tables are selected: snapshot and neuron observations both belong
  // to this fixture's Neon connection.
  return { calls, env: { ...pgMockEnv(), D1_STATE_TABLES: "" } };
}

function positionRow(hotkey: string, netuid: number, fraction: number) {
  return {
    hotkey,
    netuid,
    share_fraction: fraction,
    captured_at: CAPTURED_AT,
  };
}

describe("loadAccountPositionsFromStore", () => {
  test("retains legacy share relationships without valuing them from neuron weights", async () => {
    const { calls, env } = d1Stub(
      [positionRow(HOTKEY_A, 18, 0.5), positionRow(HOTKEY_B, 4, 0.25)],
      CAPTURED_AT,
      [
        { hotkey: HOTKEY_A, netuid: 18, stake_tao: 100 },
        { hotkey: HOTKEY_B, netuid: 4, stake_tao: 40 },
      ],
    );
    const data = await loadAccountPositionsFromStore(env as never, COLDKEY);

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
    assert.equal(data!.schema_version, 2);
    assert.equal(data!.total_stake_alpha, null);
    assert.deepEqual(
      data!.positions.map((row) => [row.netuid, row.share_fraction]),
      [
        [4, 0.25],
        [18, 0.5],
      ],
    );
    assert.ok(
      data!.positions.every(
        (row) =>
          row.alpha_rao === null &&
          row.quantity_status === "unqualified" &&
          row.provenance === null,
      ),
    );
    assert.equal(
      calls.filter((call) => call.sql.includes("FROM neurons")).length,
      0,
    );
    assert.equal(data!.positions[0]!.stake_tao, null);
    assert.equal(data!.captured_at, new Date(CAPTURED_AT).toISOString());
    assert.ok(!("degraded" in data!), "a real answer carries no degraded flag");
  });

  test.each([454, 478] as const)(
    "exact quantities use the selected runtime %s evidence and never neuron amounts",
    async (spec) => {
      const capture = syntheticAlphaCapture(CAPTURED_AT, {
        spec_version: spec,
        expected_rows: 2,
        received_rows: 2,
      });
      const rows = [
        syntheticAlphaPosition(
          COLDKEY,
          HOTKEY_A,
          18,
          "9007199254740993",
          CAPTURED_AT,
        ),
        syntheticAlphaPosition(COLDKEY, HOTKEY_B, 4, "7", CAPTURED_AT),
      ];
      const { calls, env } = d1Stub(
        rows,
        CAPTURED_AT,
        [],
        "stake-throw",
        capture,
      );
      const result = await loadAccountPositionsFromStore(env as never, COLDKEY);
      assert.equal(result?.position_count, 2);
      assert.deepEqual(
        result.positions.map((row) => row.alpha_rao),
        ["7", "9007199254740993"],
      );
      for (const row of result.positions) {
        assert.equal(row.quantity_status, "qualified_snapshot");
        assert.deepEqual(row.provenance, alphaQuantityProvenance(capture));
        assert.equal(row.stake_tao, null);
      }
      assert.equal(result.total_stake_alpha, null);
      const identityRead = calls.find((call) =>
        call.sql.includes("FROM alpha_snapshot_passes"),
      )!;
      assert.match(identityRead.sql, /JOIN alpha_runtime_metadata/);
      assert.equal(
        calls.filter((call) => call.sql.includes("FROM neurons")).length,
        0,
      );
    },
  );
  test("mixed pass stamps, Root and forged quantities retain relationships as unknown", async () => {
    const capture = syntheticAlphaCapture(CAPTURED_AT, {
      expected_rows: 2,
      received_rows: 2,
    });
    const rows = [
      syntheticAlphaPosition(COLDKEY, HOTKEY_A, 18, "7", CAPTURED_AT - 1),
      {
        ...syntheticAlphaPosition(COLDKEY, HOTKEY_B, 0, "7", CAPTURED_AT),
        source: "self_stake",
      },
      syntheticAlphaPosition(COLDKEY, HOTKEY_B, 9, "9", CAPTURED_AT),
      {
        ...syntheticAlphaPosition(COLDKEY, HOTKEY_A, 4, "7", CAPTURED_AT),
        alpha_rao: "8",
      },
    ];
    const { env } = d1Stub(rows, CAPTURED_AT, [], "ok", capture);
    const result = await loadAccountPositionsFromStore(env as never, COLDKEY);
    assert.equal(result?.position_count, 4);
    assert.deepEqual(
      result.positions.map((row) => [
        row.netuid,
        row.alpha_rao,
        row.quantity_status,
      ]),
      [
        [0, null, "unqualified"],
        [4, null, "unqualified"],
        [9, "9", "qualified_snapshot"],
        [18, null, "unqualified"],
      ],
    );
    assert.deepEqual(
      result.positions[2].provenance,
      alphaQuantityProvenance(capture),
    );
    assert.ok(
      result.positions
        .filter((row) => row.netuid !== 9)
        .every((row) => row.provenance === null),
    );
  });

  test("a failed runtime-evidence read retains observed relationships as unqualified", async () => {
    const { env } = d1Stub(
      [positionRow(HOTKEY_A, 18, 0.5)],
      CAPTURED_AT,
      [],
      "capture-throw",
    );
    const result = await loadAccountPositionsFromStore(env as never, COLDKEY);
    assert.equal(result?.position_count, 1);
    assert.equal(result.positions[0].share_fraction, 0.5);
    assert.equal(result.positions[0].quantity_status, "unqualified");
    assert.equal(result.positions[0].alpha_rao, null);
    assert.equal(result.positions[0].provenance, null);
  });
  test("legacy neuron observation helper still bounds each independent IN-list at 100 parameters", async () => {
    const hotkeys = Array.from({ length: 250 }, (_, i) => `hotkey-${i}`);
    const { calls, env } = d1Stub(
      [],
      CAPTURED_AT,
      hotkeys.map((hotkey) => ({ hotkey, netuid: 7, stake_tao: 2 })),
    );
    const observations = await neuronStakeByHotkeys(env, hotkeys);
    const queries = calls.filter((call) => call.sql.includes("FROM neurons"));
    assert.equal(queries.length, 3);
    assert.ok(queries.every((call) => call.params.length <= 100));
    assert.equal(observations?.size, 250);
  });
  test("the full 2000-relationship boundary remains available", async () => {
    assert.equal(POSITION_SCAN_CAP, 2000);
    const { env } = d1Stub(
      Array.from({ length: POSITION_SCAN_CAP }, (_, i) =>
        positionRow(HOTKEY_A, i, 1),
      ),
      CAPTURED_AT,
      [],
    );
    assert.equal(
      (await loadAccountPositionsFromStore(env as never, COLDKEY))
        ?.position_count,
      POSITION_SCAN_CAP,
    );
  });

  test("an EMPTY ledger declines so the lakehouse still answers", async () => {
    // The cutover is a property of the data, not of a deploy: until the
    // revived lane posts anything, this leg must get out of the way.
    const { env } = d1Stub([], null, []);
    assert.equal(
      await loadAccountPositionsFromStore(env as never, COLDKEY),
      null,
    );
  });

  test("a rowless coldkey in a POPULATED ledger is a live zero with a real stamp", async () => {
    // This is the whole point: "the lane has not run" and "this account holds
    // nothing" are different answers, and the old payload could not tell them
    // apart because both were `position_count: 0, captured_at: null`.
    const { calls, env } = d1Stub([], CAPTURED_AT, []);
    const data = await loadAccountPositionsFromStore(env as never, COLDKEY);
    assert.equal(data!.position_count, 0);
    assert.equal(data!.total_stake_alpha, null);
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

  test("serves hundreds of relationships without a neuron IN-list or quantity approximation", async () => {
    // Hundreds of relationship keys require only the bounded coldkey scan.
    // The old observation IN-list remains independently covered above.
    const hotkeys = Array.from(
      { length: 250 },
      (_unused, i) => `${HOTKEY_A.slice(0, 44)}${String(i).padStart(4, "0")}`,
    );
    const { calls, env } = d1Stub(
      hotkeys.map((hotkey, i) => positionRow(hotkey, i, 1)),
      CAPTURED_AT,
      hotkeys.map((hotkey, i) => ({ hotkey, netuid: i, stake_tao: 2 })),
    );
    const data = await loadAccountPositionsFromStore(env as never, COLDKEY);
    const stakeCalls = calls.filter((c) => c.sql.includes("FROM neurons"));
    assert.equal(stakeCalls.length, 0);

    assert.equal(data!.position_count, 250);
    assert.equal(data!.total_stake_alpha, null);
    assert.ok(data!.positions.every((row) => row.alpha_rao === null));
  });

  test("declines a coldkey past the scan cap rather than under-reporting its total", async () => {
    const { env } = d1Stub(
      Array.from({ length: POSITION_SCAN_CAP + 1 }, (_unused, i) =>
        positionRow(HOTKEY_A, i, 1),
      ),
      CAPTURED_AT,
      [],
    );
    assert.equal(
      await loadAccountPositionsFromStore(env as never, COLDKEY),
      null,
    );
  });

  test("declines with no binding or a throwing selected ledger; unavailable neurons cannot remove relationships", async () => {
    assert.equal(
      await loadAccountPositionsFromStore({} as never, COLDKEY),
      null,
    );
    assert.equal(await loadAccountPositionsFromStore(null, COLDKEY), null);
    assert.equal(
      await loadAccountPositionsFromStore(
        { D1_STATE_TABLES: "nominator_positions" } as never,
        COLDKEY,
      ),
      null,
      "a declared but unbound ledger must decline rather than throw or fall back",
    );
    const thrown = d1Stub([], CAPTURED_AT, [], "throw");
    assert.equal(
      await loadAccountPositionsFromStore(thrown.env as never, COLDKEY),
      null,
    );

    // The "malformed result" arm retired with the shape doubt (#10909): the
    // store guarantees an array (src/read-store.ts), so `results.length`
    // cannot be a TypeError here and there is no non-array for this loader to
    // decline on. A driver answering nonsense reads as zero rows, which
    // tests/account-summary-card.test.ts pins directly against the store.

    // Voting-weight availability is independent of whether the ledger observed
    // this relationship. It must neither drop the row nor fabricate an amount.
    const stakeDown = d1Stub(
      [positionRow(HOTKEY_A, 18, 1)],
      CAPTURED_AT,
      [],
      "stake-throw",
    );
    const retained = await loadAccountPositionsFromStore(
      stakeDown.env as never,
      COLDKEY,
    );
    assert.equal(retained?.position_count, 1);
    assert.equal(retained?.positions[0].alpha_rao, null);
    assert.equal(
      stakeDown.calls.filter((call) => call.sql.includes("FROM neurons"))
        .length,
      0,
    );
  });

  test("a non-numeric ledger stamp is treated as an empty ledger", async () => {
    const { env } = d1Stub([], "2026-08-02" as never, []);
    assert.equal(
      await loadAccountPositionsFromStore(env as never, COLDKEY),
      null,
    );
  });
});

describe("the honest-zero primitives", () => {
  test("unavailableAccountPositions labels a zero that is really a read failure", () => {
    const data = unavailableAccountPositions(COLDKEY);
    assert.equal(data.ss58, COLDKEY);
    assert.equal(data.position_count, 0);
    assert.equal(data.schema_version, 2);
    assert.equal(data.total_stake_alpha, null);
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
    // The ledger stamp only fills a null; an existing relationship vintage
    // remains visible even on an empty snapshot.
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
