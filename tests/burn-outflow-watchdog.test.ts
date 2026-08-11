// #10487: do the tokens they said they burned ever move again?
//
// A watchdog that has never fired is indistinguishable from a broken one, so
// the first requirement is proving it CAN fire. That is done twice here: on
// crafted rows, and -- because no address is declared `burn` yet -- against
// real outbound transfers pulled from production and fed in under a synthetic
// declaration held in memory. See the PR for that run's output.
//
// The second requirement is that an empty registry reports IDLE rather than OK.
// Zero declared burn addresses is the current state, and a lane reporting
// success while watching nothing is exactly how the revenue probe sat dead for
// two months (#10566).
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  BURN_OUTFLOW_DUST_FLOOR,
  detectBurnOutflow,
  runBurnOutflowWatchdog,
} from "../src/burn-outflow-watchdog.ts";
import type { WalletFlowRow } from "../src/wallet-activity.ts";

const BURN = "5C4hrfjw9DjXZTzV3MwzrrAr9P1MJhSrvWGWqi1eSuyUpnhM";
const TREASURY = "5FRYKhbmfXPDoHdUUDMx27E3HuMvAzwjzFMMq3rNurUhAyS9";

const declaredBurn = [
  { ss58: BURN, category: "burn", netuid: 64, source_urls: ["https://x/burn"] },
];

function row(over: Partial<WalletFlowRow> = {}): WalletFlowRow {
  return {
    address: BURN,
    denomination: "tao",
    direction: "out",
    amount: 5,
    observed_at: "2026-08-10T00:00:00Z",
    ...over,
  };
}

describe("it fires", () => {
  test("any outbound movement from a declared burn address is a finding", () => {
    const r = runBurnOutflowWatchdog(declaredBurn, new Map([[BURN, [row()]]]));
    assert.equal(r.verdict, "alert");
    assert.equal(r.watched, 1);
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].amount, 5);
  });

  test("one finding PER EVENT, with its own amount and stamp", () => {
    // A rolling summary answers "how much left this quarter", which cannot be
    // looked up on chain and argued with. A single movement can.
    const r = runBurnOutflowWatchdog(
      declaredBurn,
      new Map([
        [
          BURN,
          [
            row({ amount: 1, observed_at: "2026-08-01T00:00:00Z" }),
            row({ amount: 2, observed_at: "2026-08-02T00:00:00Z" }),
          ],
        ],
      ]),
    );
    assert.equal(r.findings.length, 2);
    assert.deepEqual(
      r.findings.map((f) => [f.amount, f.observed_at]),
      [
        [1, "2026-08-01T00:00:00Z"],
        [2, "2026-08-02T00:00:00Z"],
      ],
    );
  });

  test("alpha outbound fires too, and carries its netuid", () => {
    const r = runBurnOutflowWatchdog(
      declaredBurn,
      new Map([
        [BURN, [row({ denomination: "alpha", netuid: 64, amount: 9 })]],
      ]),
    );
    assert.equal(r.findings[0].denomination, "alpha");
    assert.equal(r.findings[0].netuid, 64);
  });

  test("every finding carries the evidence behind the claim it contradicts", () => {
    // A reader must be able to check the ATTRIBUTION without a second lookup --
    // our own attribution being wrong is the first listed reading.
    const r = runBurnOutflowWatchdog(declaredBurn, new Map([[BURN, [row()]]]));
    assert.deepEqual(r.findings[0].source_urls, ["https://x/burn"]);
  });

  test("the wording is fixed, and refuses to allege intent", () => {
    // Settled once here rather than improvised per event: this is the
    // highest-blast-radius thing either epic emits.
    const [finding] = detectBurnOutflow(
      declaredBurn,
      new Map([[BURN, [row()]]]),
    );
    assert.match(finding.reading, /not a finding of misconduct/);
    assert.match(finding.reading, /attribution may be wrong/);
    assert.match(finding.reading, /cannot distinguish/);
  });
});

describe("it does not fire on the wrong things", () => {
  test("inbound movement is not a discrepancy", () => {
    // Tokens ARRIVING at a burn address is the burn happening.
    const r = runBurnOutflowWatchdog(
      declaredBurn,
      new Map([[BURN, [row({ direction: "in", amount: 1000 })]]]),
    );
    assert.equal(r.verdict, "ok");
    assert.equal(r.findings.length, 0);
  });

  test("a treasury moving funds is ordinary activity", () => {
    // Reporting it here would drown the one signal that matters.
    const r = runBurnOutflowWatchdog(
      [{ ss58: TREASURY, category: "treasury" }],
      new Map([[TREASURY, [row({ address: TREASURY, amount: 10_000 })]]]),
    );
    assert.equal(r.verdict, "idle", "no burn addresses were watched at all");
    assert.equal(r.findings.length, 0);
  });

  test("dust below the noise floor is not a movement", () => {
    // The floor is about index artefacts, NOT tolerance: a burn address should
    // have exactly zero outbound, so there is no band to tune.
    const r = runBurnOutflowWatchdog(
      declaredBurn,
      new Map([[BURN, [row({ amount: BURN_OUTFLOW_DUST_FLOOR / 2 })]]]),
    );
    assert.equal(r.findings.length, 0);
    // But anything above it fires, however small.
    const fires = runBurnOutflowWatchdog(
      declaredBurn,
      new Map([[BURN, [row({ amount: BURN_OUTFLOW_DUST_FLOOR * 10 })]]]),
    );
    assert.equal(fires.findings.length, 1);
  });

  test("unreadable rows do not fabricate a finding", () => {
    const r = runBurnOutflowWatchdog(
      declaredBurn,
      new Map([
        [
          BURN,
          [
            row({ amount: null }),
            row({ amount: Number.NaN }),
            row({ denomination: "usd" as never }),
            row({ address: TREASURY }),
          ],
        ],
      ]),
    );
    assert.equal(r.findings.length, 0);
    assert.equal(r.verdict, "ok");
  });
});

describe("watching nothing is not the same as finding nothing", () => {
  test("an empty registry is IDLE, never ok", () => {
    for (const wallets of [
      null,
      undefined,
      [],
      [{ ss58: "", category: "burn" }],
    ]) {
      const r = runBurnOutflowWatchdog(wallets as never, new Map());
      assert.equal(r.verdict, "idle");
      assert.equal(r.watched, 0);
      assert.match(r.detail, /not the same claim as finding nothing/);
    }
  });

  test("a declared burn address with no rows is OK, because it WAS watched", () => {
    const r = runBurnOutflowWatchdog(declaredBurn, new Map());
    assert.equal(r.verdict, "ok");
    assert.equal(r.watched, 1);
  });

  test("degenerate declarations and rows produce no half-formed finding", () => {
    // Each of these is a shape the registry should never hold, but a watchdog
    // whose output is read as an allegation must not emit a partial record
    // from one.
    const findings = detectBurnOutflow(
      [
        // Non-string ss58: not an address, so nothing is watched for it.
        { ss58: undefined as unknown as string, category: "burn" },
        // Declared burn with NO evidence -- the finding still carries an empty
        // source_urls rather than undefined, so a reader sees "no evidence
        // was recorded" instead of a missing key.
        { ss58: BURN, category: "burn" },
      ],
      new Map([
        [
          BURN,
          [
            // Alpha with an unreadable netuid still fires -- the movement is
            // real even when we cannot say which subnet's token it was.
            row({ denomination: "alpha", netuid: null, amount: 3 }),
            // A stampless row fires too; the amount is the finding.
            row({ observed_at: null, amount: 4 }),
          ],
        ],
      ]),
    );
    assert.equal(findings.length, 2);
    const alpha = findings.find((f) => f.denomination === "alpha");
    assert.equal(alpha?.netuid, null);
    assert.deepEqual(
      alpha?.source_urls,
      [],
      "no evidence recorded, not absent",
    );
    const stampless = findings.find((f) => f.denomination === "tao");
    assert.equal(stampless?.observed_at, null);
  });

  test("junk input yields no findings rather than throwing", () => {
    assert.deepEqual(detectBurnOutflow(null, null), []);
    assert.deepEqual(detectBurnOutflow("no" as never, new Map()), []);
  });
});
