// The deregistration projection readers, all three scopes (#9307).
//
// The failure modes specific to THESE readers:
//   - answering a window the lane did not derive with another window's
//     numbers. The account scope offers 90d and the lane derives 7d/30d, so
//     that is a live case, not a defensive one.
//   - fetching the 1.5 MB per-hotkey index for the chain/subnet scopes, which
//     read an ~8 KB rollup. The key each reader touches is asserted.
//   - conflating "this subject had no evictions" with "nothing derived": the
//     first is a real zero the lane measured, the second must be marked.

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  CHAIN_DEREGISTRATIONS_HOTKEY_PROJECTION_KEY,
  CHAIN_DEREGISTRATIONS_PROJECTION_KEY,
  loadAccountDeregistrationsFromArtifact,
  loadChainDeregistrationsFromArtifact,
  loadSubnetDeregistrationsFromArtifact,
  markDeregistrationsNotDerived,
} from "../src/chain-deregistrations-artifact.ts";
import { DEREGISTRATIONS_DEGRADED_NOT_DERIVED } from "../src/uncurated-event-streams.ts";
import type { Row } from "./row-type.ts";

const NEWEST = 1_785_784_392_000;

const DERIVATION_7D = {
  method: "uid-reuse",
  lookback_days: 30,
  window_registrations: 8064,
  unattributed_registrations: 1726,
};

function subnetRow(
  netuid: number,
  deregistrations: number,
  hotkeys: number,
  newest = NEWEST,
) {
  return {
    netuid,
    deregistrations,
    distinct_deregistered_hotkeys: hotkeys,
    newest_observed: newest,
  };
}

const ROLLUP_BODY = {
  schema_version: 1,
  generated_at: "2026-08-03T19:14:36.000Z",
  row_count: 3,
  lookback_days: 30,
  windows: {
    "7d": {
      days: 7,
      // 441 + 429 + 420 = 1,290 events but only 900 DISTINCT hotkeys
      // network-wide -- deliberately under the row sum (432 + 356 + 118 = 906)
      // so an overcount is visible.
      network: { distinct_deregistered_hotkeys: 900, newest_observed: NEWEST },
      rows: [
        subnetRow(3, 441, 432),
        subnetRow(45, 429, 356),
        subnetRow(68, 420, 118, NEWEST - 5000),
      ],
      derivation: DERIVATION_7D,
    },
    "30d": {
      days: 30,
      network: { distinct_deregistered_hotkeys: 12, newest_observed: NEWEST },
      rows: [subnetRow(1, 20, 12)],
      derivation: { ...DERIVATION_7D, window_registrations: 33386 },
    },
  },
};

const HOTKEY_BODY = {
  schema_version: 1,
  generated_at: "2026-08-03T19:14:36.000Z",
  lookback_days: 30,
  windows: {
    "7d": {
      days: 7,
      hotkeys: {
        "5A": [
          [5, 2, NEWEST - 20_000, NEWEST - 10_000],
          [9, 1, NEWEST, NEWEST],
        ],
      },
      derivation: DERIVATION_7D,
    },
    "30d": { days: 30, hotkeys: {}, derivation: DERIVATION_7D },
  },
};

/** An R2 double serving `bodies` by key; every other key resolves null. */
function envWith(
  bodies: Record<string, unknown>,
  opts: { throws?: boolean } = {},
) {
  const keys: string[] = [];
  return {
    keys,
    env: {
      METAGRAPH_ARCHIVE: {
        get(key: string) {
          keys.push(key);
          if (opts.throws) return Promise.reject(new Error("r2 down"));
          if (!Object.hasOwn(bodies, key)) return Promise.resolve(null);
          return Promise.resolve({ json: () => Promise.resolve(bodies[key]) });
        },
      },
    } as unknown as Env,
  };
}

const ROLLUP_ENV = { [CHAIN_DEREGISTRATIONS_PROJECTION_KEY]: ROLLUP_BODY };
const HOTKEY_ENV = {
  [CHAIN_DEREGISTRATIONS_HOTKEY_PROJECTION_KEY]: HOTKEY_BODY,
};

describe("loadChainDeregistrationsFromArtifact", () => {
  test("ranks the leaderboard and echoes the derivation's lower bound", async () => {
    const { env, keys } = envWith(ROLLUP_ENV);
    const out = (await loadChainDeregistrationsFromArtifact(env, {
      window: "7d",
    })) as Row;
    assert.equal(out.subnet_count, 3);
    assert.deepEqual(
      (out.subnets as Row[]).map((s) => s.netuid),
      [3, 45, 68],
    );
    assert.equal((out.subnets as Row[])[0]!.deregistrations, 441);
    // The honest part: 1,726 of the window's 8,064 registrations displaced a
    // holder we cannot name, so the total is a stated lower bound.
    assert.deepEqual(out.derivation, DERIVATION_7D);
    assert.equal(out.degraded, undefined);
    // Never the 1.5 MB per-hotkey object.
    assert.deepEqual(keys, [CHAIN_DEREGISTRATIONS_PROJECTION_KEY]);
  });

  test("uses the stored network rollup, never a sum of the rows", async () => {
    const { env } = envWith(ROLLUP_ENV);
    const out = (await loadChainDeregistrationsFromArtifact(env, {
      window: "7d",
    })) as Row;
    assert.equal((out.network as Row).distinct_deregistered_hotkeys, 900);
    assert.notEqual((out.network as Row).distinct_deregistered_hotkeys, 906);
  });

  test("defaults to the route's own window and honours the limit", async () => {
    const { env } = envWith(ROLLUP_ENV);
    const out = (await loadChainDeregistrationsFromArtifact(env, {
      limit: 1,
    })) as Row;
    assert.equal(out.window, "7d");
    assert.equal((out.subnets as Row[]).length, 1);
    assert.equal(out.subnet_count, 3, "the count spans every subnet");
  });

  test("declines a window the route does not offer", async () => {
    const { env } = envWith(ROLLUP_ENV);
    assert.equal(
      await loadChainDeregistrationsFromArtifact(env, { window: "90d" }),
      null,
    );
  });

  test("declines a window the lane did not derive", async () => {
    const { env } = envWith({
      [CHAIN_DEREGISTRATIONS_PROJECTION_KEY]: {
        ...ROLLUP_BODY,
        windows: { "30d": ROLLUP_BODY.windows["30d"] },
      },
    });
    assert.equal(
      await loadChainDeregistrationsFromArtifact(env, { window: "7d" }),
      null,
    );
  });

  test("declines a body without rows rather than serving an invented empty", async () => {
    const { env } = envWith({
      [CHAIN_DEREGISTRATIONS_PROJECTION_KEY]: {
        ...ROLLUP_BODY,
        windows: { "7d": { days: 7, network: {} } },
      },
    });
    assert.equal(
      await loadChainDeregistrationsFromArtifact(env, { window: "7d" }),
      null,
    );
  });

  test("serves a body the lane wrote before the derivation echo existed", async () => {
    // Also carries no `network` block at all, so the reader's rollup
    // pass-through has to tolerate its absence rather than assume it.
    const { env } = envWith({
      [CHAIN_DEREGISTRATIONS_PROJECTION_KEY]: {
        ...ROLLUP_BODY,
        windows: {
          "7d": { days: 7, rows: [subnetRow(3, 5, 4)] },
        },
      },
    });
    const out = (await loadChainDeregistrationsFromArtifact(env, {
      window: "7d",
    })) as Row;
    assert.equal(out.subnet_count, 1);
    assert.equal(out.derivation, undefined);
  });

  test.each([
    ["unbound store", {}, {}],
    ["missing object", { "some/other/key.json": ROLLUP_BODY }, {}],
    [
      "unrecognized body",
      { [CHAIN_DEREGISTRATIONS_PROJECTION_KEY]: { schema_version: 2 } },
      {},
    ],
    [
      "null windows",
      {
        [CHAIN_DEREGISTRATIONS_PROJECTION_KEY]: {
          schema_version: 1,
          windows: null,
        },
      },
      {},
    ],
    ["throwing store", ROLLUP_ENV, { throws: true }],
  ])("declines on %s", async (_label, bodies, opts) => {
    const { env } = envWith(bodies as Record<string, unknown>, opts);
    assert.equal(
      await loadChainDeregistrationsFromArtifact(env, { window: "7d" }),
      null,
    );
  });

  test("declines when the binding itself is absent", async () => {
    assert.equal(
      await loadChainDeregistrationsFromArtifact(null, { window: "7d" }),
      null,
    );
    assert.equal(
      await loadChainDeregistrationsFromArtifact(
        { METAGRAPH_ARCHIVE: {} } as unknown as Env,
        { window: "7d" },
      ),
      null,
    );
  });
});

describe("loadSubnetDeregistrationsFromArtifact", () => {
  test("reads one subnet out of the SAME rows the leaderboard ranks", async () => {
    const { env, keys } = envWith(ROLLUP_ENV);
    const out = (await loadSubnetDeregistrationsFromArtifact(env, 45, {
      window: "7d",
    })) as Row;
    assert.equal(out.netuid, 45);
    assert.equal(out.deregistrations, 429);
    assert.equal(out.distinct_deregistered_hotkeys, 356);
    assert.equal(out.observed_at, new Date(NEWEST).toISOString());
    assert.deepEqual(out.derivation, DERIVATION_7D);
    assert.deepEqual(keys, [CHAIN_DEREGISTRATIONS_PROJECTION_KEY]);
  });

  test("a subnet with no row is a MEASURED zero, not a decline", async () => {
    // The lane derives every subnet in the window, so "no row" means "no slot
    // on this subnet changed hands" -- declining here would mark a measured
    // quiet as unanswerable.
    const { env } = envWith(ROLLUP_ENV);
    const out = (await loadSubnetDeregistrationsFromArtifact(env, 999, {
      window: "7d",
    })) as Row;
    assert.equal(out.deregistrations, 0);
    assert.equal(out.degraded, undefined);
    assert.deepEqual(out.derivation, DERIVATION_7D);
  });

  test("defaults to the route's own window", async () => {
    const { env } = envWith(ROLLUP_ENV);
    const out = (await loadSubnetDeregistrationsFromArtifact(env, 3)) as Row;
    assert.equal(out.window, "7d");
  });

  test("declines a window the route does not offer", async () => {
    const { env } = envWith(ROLLUP_ENV);
    assert.equal(
      await loadSubnetDeregistrationsFromArtifact(env, 3, { window: "90d" }),
      null,
    );
  });

  test("declines a body without rows", async () => {
    const { env } = envWith({
      [CHAIN_DEREGISTRATIONS_PROJECTION_KEY]: {
        ...ROLLUP_BODY,
        windows: { "7d": { days: 7 } },
      },
    });
    assert.equal(
      await loadSubnetDeregistrationsFromArtifact(env, 3, { window: "7d" }),
      null,
    );
  });

  test("declines an unbound store", async () => {
    assert.equal(await loadSubnetDeregistrationsFromArtifact(null, 3), null);
  });

  test("serves a body written before the derivation echo existed", async () => {
    const { env } = envWith({
      [CHAIN_DEREGISTRATIONS_PROJECTION_KEY]: {
        ...ROLLUP_BODY,
        windows: { "7d": { days: 7, rows: [subnetRow(3, 5, 4)] } },
      },
    });
    const out = (await loadSubnetDeregistrationsFromArtifact(env, 3, {
      window: "7d",
    })) as Row;
    assert.equal(out.deregistrations, 5);
    assert.equal(out.derivation, undefined);
  });
});

describe("loadAccountDeregistrationsFromArtifact", () => {
  test("reads the slots where this hotkey was the PREVIOUS holder", async () => {
    const { env, keys } = envWith(HOTKEY_ENV);
    const out = await loadAccountDeregistrationsFromArtifact(env, "5A", {
      window: "7d",
    });
    assert.ok(out);
    assert.equal(out.data.total_deregistrations, 3);
    assert.deepEqual(
      out.data.subnets.map((s) => [s.netuid, s.deregistrations]),
      [
        [5, 2],
        [9, 1],
      ],
    );
    assert.equal(
      out.data.subnets[0]!.first_deregistered_at,
      new Date(NEWEST - 20_000).toISOString(),
    );
    assert.equal(out.generatedAt, new Date(NEWEST).toISOString());
    assert.deepEqual(out.data.derivation, DERIVATION_7D);
    // Only the per-hotkey object -- never the rollup the other scopes read.
    assert.deepEqual(keys, [CHAIN_DEREGISTRATIONS_HOTKEY_PROJECTION_KEY]);
  });

  test("an address absent from the index is a MEASURED zero", async () => {
    const { env } = envWith(HOTKEY_ENV);
    const out = await loadAccountDeregistrationsFromArtifact(env, "5Z", {
      window: "7d",
    });
    assert.ok(out);
    assert.equal(out.data.total_deregistrations, 0);
    assert.equal(out.generatedAt, null);
    assert.equal(out.data.degraded, undefined);
  });

  test("declines the 90d window the lane does not derive", async () => {
    // The route offers 90d; answering it with the 30d index would be a wrong
    // answer wearing a correct window label.
    const { env } = envWith(HOTKEY_ENV);
    assert.equal(
      await loadAccountDeregistrationsFromArtifact(env, "5A", {
        window: "90d",
      }),
      null,
    );
  });

  test("defaults to the account route's own 30d window", async () => {
    const { env } = envWith(HOTKEY_ENV);
    const out = await loadAccountDeregistrationsFromArtifact(env, "5A");
    assert.equal(out?.data.window, "30d");
  });

  test("declines a window body carrying no index", async () => {
    const { env } = envWith({
      [CHAIN_DEREGISTRATIONS_HOTKEY_PROJECTION_KEY]: {
        ...HOTKEY_BODY,
        windows: { "7d": { days: 7, hotkeys: null } },
      },
    });
    assert.equal(
      await loadAccountDeregistrationsFromArtifact(env, "5A", {
        window: "7d",
      }),
      null,
    );
  });

  test("declines an unbound store", async () => {
    assert.equal(
      await loadAccountDeregistrationsFromArtifact(null, "5A"),
      null,
    );
  });

  test("serves a body written before the derivation echo existed", async () => {
    const { env } = envWith({
      [CHAIN_DEREGISTRATIONS_HOTKEY_PROJECTION_KEY]: {
        ...HOTKEY_BODY,
        windows: { "7d": { days: 7, hotkeys: { "5A": [[5, 1, 10, 10]] } } },
      },
    });
    const out = await loadAccountDeregistrationsFromArtifact(env, "5A", {
      window: "7d",
    });
    assert.equal(out?.data.total_deregistrations, 1);
    assert.equal(out?.data.derivation, undefined);
  });

  test("ignores a non-finite last_observed when stamping generatedAt", async () => {
    const { env } = envWith({
      [CHAIN_DEREGISTRATIONS_HOTKEY_PROJECTION_KEY]: {
        ...HOTKEY_BODY,
        windows: {
          "7d": { days: 7, hotkeys: { "5A": [[5, 1, 10, "nope"]] } },
        },
      },
    });
    const out = await loadAccountDeregistrationsFromArtifact(env, "5A", {
      window: "7d",
    });
    assert.equal(out?.generatedAt, null);
  });
});

describe("markDeregistrationsNotDerived", () => {
  test("names the reason so a zero is never read as a measurement", () => {
    const marked = markDeregistrationsNotDerived({ deregistrations: 0 }) as Row;
    assert.deepEqual(marked.degraded, {
      reason: DEREGISTRATIONS_DEGRADED_NOT_DERIVED,
    });
  });
});
