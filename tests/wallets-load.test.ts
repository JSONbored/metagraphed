// #10488: the money map as served.
//
// Two things are asserted harder than the arithmetic, because they are the
// difference between a number and an allegation:
//
//   - a declared wallet's `source_urls` travel WITH it, so a consumer repeating
//     the attribution can check it without a second call;
//   - `owner` is chain-derived and flagged, so nobody has to infer "this came
//     from SubnetOwner" from an absent evidence list.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { loadSubnetOwnerCut, subnetWalletRows } from "../src/wallets-load.ts";

const OWNER_COLD = "5FRYKhbmfXPDoHdUUDMx27E3HuMvAzwjzFMMq3rNurUhAyS9";
const OWNER_HOT = "5CS3g6nVJM6ouns8n9buN9CzFf2C1YDHVcVGRcxoirKs2xbV";
const TREASURY = "5EvYE2R9HhPpCk9M2hGgAy9HJ3seergi2cc14hqVkh3aeUy1";

const ECONOMICS = {
  netuid: 64,
  owner_coldkey: OWNER_COLD,
  owner_hotkey: OWNER_HOT,
  alpha_out_emission: 1,
  alpha_price_tao: 0.086933658,
};

const OWNER_CUT = 11796 / 65535;

describe("the wallet list", () => {
  test("includes the chain-derived owner keys, flagged, with no evidence", () => {
    // `owner` is read from SubnetOwner. An empty source_urls here means "needs
    // none", and the flag is what says so -- inferring it from the absence
    // would make an unevidenced attribution look identical to a chain read.
    const rows = subnetWalletRows(64, ECONOMICS, null, null);
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.equal(r.role, "owner");
      assert.equal(r.chain_derived, true);
      assert.deepEqual(r.source_urls, []);
    }
    assert.deepEqual(
      rows.map((r) => r.ss58),
      [OWNER_COLD, OWNER_HOT],
    );
  });

  test("a declared wallet carries its evidence and is NOT chain-derived", () => {
    const rows = subnetWalletRows(
      64,
      ECONOMICS,
      [
        {
          ss58: TREASURY,
          category: "treasury",
          netuid: 64,
          name: "Example Treasury",
          source_urls: ["https://example.org/treasury"],
        },
      ],
      null,
    );
    const treasury = rows.find((r) => r.ss58 === TREASURY);
    assert.ok(treasury);
    assert.equal(treasury.chain_derived, false);
    assert.deepEqual(treasury.source_urls, ["https://example.org/treasury"]);
    assert.equal(treasury.name, "Example Treasury");
  });

  test("a hand-declared `owner` is refused", () => {
    // owner is chain-derived by definition; honouring a declared one would let
    // a registry entry impersonate a SubnetOwner read.
    const rows = subnetWalletRows(
      64,
      null,
      [{ ss58: TREASURY, category: "owner", netuid: 64, source_urls: ["x"] }],
      null,
    );
    assert.deepEqual(rows, []);
  });

  test("entities for another subnet are not borrowed", () => {
    const rows = subnetWalletRows(
      64,
      null,
      [
        {
          ss58: TREASURY,
          category: "treasury",
          netuid: 51,
          source_urls: ["x"],
        },
      ],
      null,
    );
    assert.deepEqual(rows, []);
  });

  test("a burn declaration carries its unspendability basis", () => {
    const rows = subnetWalletRows(
      64,
      null,
      [
        {
          ss58: TREASURY,
          category: "burn",
          netuid: 64,
          source_urls: ["https://x"],
          unspendable_proof: { basis: "known-black-hole" },
        },
      ],
      null,
    );
    assert.equal(rows[0].unspendable_proof_basis, "known-black-hole");
  });

  test("an owner key declared again is not listed twice", () => {
    const rows = subnetWalletRows(
      64,
      ECONOMICS,
      [
        {
          ss58: OWNER_COLD,
          category: "treasury",
          netuid: 64,
          source_urls: ["x"],
        },
      ],
      null,
    );
    assert.equal(rows.filter((r) => r.ss58 === OWNER_COLD).length, 1);
    // The chain-derived reading wins: it cannot be overridden by a declaration.
    assert.equal(rows.find((r) => r.ss58 === OWNER_COLD)?.role, "owner");
  });

  test("malformed entity rows are skipped rather than half-rendered", () => {
    // Each of these is a shape registry/entities/ should never hold, but a
    // response read as an attribution must not carry a partial record from one.
    const rows = subnetWalletRows(
      64,
      null,
      [
        { ss58: null, category: "treasury", netuid: 64 },
        { ss58: 12345, category: "treasury", netuid: 64 },
        { ss58: TREASURY, netuid: 64 },
        { ss58: TREASURY, category: "", netuid: 64 },
      ],
      null,
    );
    assert.deepEqual(rows, [], "no category and no ss58 both mean no wallet");
  });

  test("a declared wallet with no source_urls still serialises an array", () => {
    // The registry refuses an entry without evidence, so this shape should not
    // reach us -- but if it does, an EMPTY array reads as "none was recorded"
    // where an absent key would read as "the field does not apply".
    const rows = subnetWalletRows(
      64,
      null,
      [{ ss58: TREASURY, category: "multisig", netuid: 64 }],
      null,
    );
    assert.deepEqual(rows[0].source_urls, []);
    assert.equal(rows[0].name, null);
    assert.equal(rows[0].unspendable_proof_basis, null);
  });

  test("no economics and no entities is an empty list, not an error", () => {
    // 128 subnets are in this state. It means nothing has been attributed,
    // which is not the same as nothing existing.
    assert.deepEqual(subnetWalletRows(64, null, null, null), []);
    assert.deepEqual(subnetWalletRows(64, {}, [], null), []);
  });

  test("the served activity does not restate its parent", () => {
    const [row] = subnetWalletRows(64, ECONOMICS, null, null);
    assert.equal("address" in row.activity, false);
    assert.equal("window_days" in row.activity, false);
    assert.deepEqual(row.activity.legs, []);
  });
});

describe("the owner-cut view", () => {
  test("composes the accrual and echoes the share", () => {
    const v = loadSubnetOwnerCut({
      netuid: 64,
      window_days: 1,
      economics: ECONOMICS,
      owner_cut: OWNER_CUT,
      usd_per_tao: 204.03,
    });
    assert.equal(v.owner_coldkey, OWNER_COLD);
    assert.equal(v.owner_hotkey, OWNER_HOT);
    assert.equal(v.accrual.owner_cut, OWNER_CUT);
    assert.ok((v.accrual.alpha as number) > 0);
  });

  test("with no flow read the disposition is UNRESOLVED, not held", () => {
    // The route does not read the stake streams yet, so this is the shape it
    // actually serves -- and claiming `held-as-stake` from a read we did not
    // perform is the false negative #10485 exists to prevent.
    const v = loadSubnetOwnerCut({
      netuid: 64,
      economics: ECONOMICS,
      owner_cut: OWNER_CUT,
      usd_per_tao: null,
    });
    assert.equal(v.disposition.buckets["held-as-stake"], null);
    assert.ok((v.disposition.buckets.unresolved as number) > 0);
    assert.equal(v.disposition.reconciles, false);
    assert.match(v.disposition.notes.join(" "), /unresolved, not held/);
  });

  test("an unresolvable share nulls the accrual rather than assuming 18%", () => {
    const v = loadSubnetOwnerCut({
      netuid: 64,
      economics: ECONOMICS,
      owner_cut: null,
      usd_per_tao: null,
    });
    assert.equal(v.accrual.alpha, null);
    assert.match(String(v.accrual.reason), /owner cut share not read/);
  });

  test("no economics still answers, with null owner keys", () => {
    const v = loadSubnetOwnerCut({
      netuid: 999,
      economics: null,
      owner_cut: OWNER_CUT,
      usd_per_tao: null,
    });
    assert.equal(v.owner_coldkey, null);
    assert.equal(v.owner_hotkey, null);
    assert.equal(v.accrual.alpha, null);
  });

  test("the sub-objects do not restate the netuid or window", () => {
    const v = loadSubnetOwnerCut({
      netuid: 64,
      economics: ECONOMICS,
      owner_cut: OWNER_CUT,
      usd_per_tao: null,
    });
    assert.equal("netuid" in v.accrual, false);
    assert.equal("window_days" in v.accrual, false);
    assert.equal("netuid" in v.disposition, false);
  });
});
