// MET-7385: a subnet's owner share is its current declared split's owner
// slot, read from the state store, and null whenever that is not what the
// store holds -- never the runtime's 18% assumed in its place.
import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import {
  loadOwnerShare,
  loadOwnerShares,
  ownerShareOf,
  ownerSharesOf,
} from "../src/owner-share.ts";

type Row = Record<string, unknown>;

/** SN3 on finney at 9,606,539: owner 18%, validators and miners 36% each,
 * and 10% to SN51's gamma. */
const splitRow = (overrides: Row = {}) => ({
  netuid: 3,
  burn_parts: "0",
  recycle_parts: "0",
  owner_parts: "3320413933267719290",
  validator_parts: "6640827866535438581",
  miner_parts: "6640827866535438583",
  gamma_shares: [{ target: 51, parts: "1844674407370955161" }],
  valid_from: "9604739",
  valid_to: null as string | null,
  ...overrides,
});
/** SN20 the same day: a declared 33% owner slot. */
const SN20 = splitRow({
  netuid: 20,
  owner_parts: "6087425544324152032",
  validator_parts: "1291272085159668613",
  miner_parts: "11068046444225730970",
  gamma_shares: [],
});
const observation = {
  block_number: "9606539",
  observed_at_ms: "1795900000000",
};
const history = (splits: ReturnType<typeof splitRow>[]) => ({
  observation,
  splits,
  lifecycle: [],
});

describe("ownerShareOf", () => {
  test("the current range's owner slot", () => {
    assert.ok(
      Math.abs((ownerShareOf(history([splitRow()])) ?? 0) - 0.18) < 1e-12,
    );
  });

  test("the CURRENT range, wherever it sits among the closed ones", () => {
    const closed = splitRow({
      owner_parts: "0",
      validator_parts: "9223372036854775807",
      miner_parts: "9223372036854775808",
      valid_from: "9600000",
      valid_to: "9604739",
    });
    assert.ok(
      Math.abs((ownerShareOf(history([closed, splitRow()])) ?? 0) - 0.18) <
        1e-12,
    );
  });

  test("null for every reading that is not a current split", () => {
    assert.equal(ownerShareOf(null), null);
    assert.equal(ownerShareOf(undefined), null);
    // A store bound before its first capture.
    assert.equal(
      ownerShareOf({ ...history([splitRow()]), observation: null }),
      null,
    );
    // A subnet whose last range closed: deregistered at the observed block.
    assert.equal(
      ownerShareOf(history([splitRow({ valid_to: "9606000" })])),
      null,
    );
    assert.equal(ownerShareOf(history([])), null);
    // A row that does not read whole is not a share either.
    assert.equal(
      ownerShareOf(history([splitRow({ owner_parts: "-1" })])),
      null,
    );
  });
});

describe("ownerSharesOf", () => {
  test("every current split by netuid, skipping what does not read whole", () => {
    const shares = ownerSharesOf({
      observation,
      splits: [
        splitRow(),
        SN20,
        splitRow({ netuid: 8, valid_to: "9606000" }),
        splitRow({ netuid: 9, gamma_shares: null }),
      ],
      lifecycle: [],
    });
    assert.deepEqual([...shares.keys()], [3, 20]);
    assert.ok(Math.abs((shares.get(20) ?? 0) - 0.33) < 1e-12);
  });

  test("empty with no store reading or no capture observed", () => {
    assert.equal(ownerSharesOf(null).size, 0);
    assert.equal(ownerSharesOf(undefined).size, 0);
    assert.equal(
      ownerSharesOf({ observation: null, splits: [splitRow()], lifecycle: [] })
        .size,
      0,
    );
  });
});

describe("the loaders", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const store = (overrides: Row = {}) => ({
    write: async () => ({ written: true, opened: 0, closed: 0 }),
    current: async () => history([splitRow(), SN20]),
    subnet: vi.fn(async (_netuid: number) => history([splitRow()])),
    ...overrides,
  });

  test("read the bound store: one subnet, and every subnet in one read", async () => {
    const bound = store();
    const env = { SUBNET_EMISSION_STORE: bound };
    assert.ok(Math.abs(((await loadOwnerShare(env, 3)) ?? 0) - 0.18) < 1e-12);
    assert.deepEqual(bound.subnet.mock.calls, [[3]]);
    const shares = await loadOwnerShares(env);
    assert.deepEqual([...shares.keys()], [3, 20]);
  });

  test("no store bound is no share, without a read", async () => {
    assert.equal(await loadOwnerShare({}, 3), null);
    assert.equal(await loadOwnerShare(null, 3), null);
    assert.equal((await loadOwnerShares({})).size, 0);
  });

  test("a failed or misconfigured store is no share, and says so", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = store({
      current: async () => {
        throw new Error("connection reset");
      },
      subnet: async () => {
        throw new Error("connection reset");
      },
    });
    assert.equal(
      await loadOwnerShare({ SUBNET_EMISSION_STORE: failing }, 3),
      null,
    );
    assert.equal(
      (await loadOwnerShares({ SUBNET_EMISSION_STORE: failing })).size,
      0,
    );
    // A store of the wrong shape is a TypeError from the seam, caught the same.
    assert.equal(await loadOwnerShare({ SUBNET_EMISSION_STORE: {} }, 3), null);
    assert.equal(
      (await loadOwnerShares({ SUBNET_EMISSION_STORE: {} })).size,
      0,
    );
    assert.equal(logged.mock.calls.length, 4);
    assert.match(
      String(logged.mock.calls[0][0]),
      /subnet emission store read failed/,
    );
  });
});
