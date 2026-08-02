// #8696: the alerting rule for the SafeMode monitor, tested without a chain.
//
// The edges ARE the feature. #8697's audit said SafeMode had "never been
// called" and proposed alerting on first use; re-running that census against
// the completed index found one call — block 4,222,830, FAILED, from an
// unprivileged signer. A monitor that fires on it teaches its reader to ignore
// it, so the rule keys on SUCCESS, and the historical failure has to stay
// visible in the summary without being alerted on.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { evaluateSafeMode } from "../scripts/check-safe-mode.ts";

/** The one real SafeMode extrinsic on finney, as the index returns it. */
const HISTORICAL_FAILURE = {
  block_number: 4_222_830,
  call_function: "force_release_deposit",
  success: false,
  signer: "5H6tCSXfWreW",
};

describe("SafeMode alerting rule (#8696)", () => {
  test("the quiet chain is the steady state and alerts nothing", () => {
    const v = evaluateSafeMode({
      enteredUntil: null,
      extrinsics: [HISTORICAL_FAILURE],
    });
    assert.deepEqual(v.reasons, []);
    assert.equal(v.paused, false);
  });

  test("the known historical FAILURE is reported but never alerted on", () => {
    const v = evaluateSafeMode({
      enteredUntil: null,
      extrinsics: [HISTORICAL_FAILURE],
    });
    // Visible...
    assert.deepEqual(v.summary.known_failed, ["4222830:force_release_deposit"]);
    assert.equal(v.summary.safe_mode_extrinsics, 1);
    // ...and not a reason to wake anyone.
    assert.equal(v.summary.succeeded, 0);
    assert.deepEqual(v.reasons, []);
  });

  test("a SUCCESSFUL extrinsic alerts, naming block and signer", () => {
    const v = evaluateSafeMode({
      enteredUntil: null,
      extrinsics: [
        HISTORICAL_FAILURE,
        {
          block_number: 9_000_000,
          call_function: "enter",
          success: true,
          signer: null,
        },
      ],
    });
    assert.equal(v.reasons.length, 1);
    assert.match(v.reasons[0], /SUCCEEDED — block 9000000, enter, signer root/);
  });

  test("an ACTIVE pause alerts even with no extrinsic behind it", () => {
    // Safe mode can be entered by root with no signed SafeMode extrinsic ever
    // appearing, so storage is the authoritative signal — an extrinsic-only
    // monitor would miss exactly the case that matters most.
    const v = evaluateSafeMode({
      enteredUntil: "0x40e2010000000000",
      extrinsics: [],
    });
    assert.equal(v.paused, true);
    assert.equal(v.reasons.length, 1);
    assert.match(v.reasons[0], /SafeMode is ACTIVE/);
  });

  test("an empty storage value is not a pause", () => {
    // `null` is an unset key; "0x" is present-but-empty, which is not a block
    // number. Reading either as a pause would alert on a quiet chain forever.
    for (const enteredUntil of [null, "0x"]) {
      const v = evaluateSafeMode({ enteredUntil, extrinsics: [] });
      assert.equal(v.paused, false, `${enteredUntil} must not read as paused`);
      assert.deepEqual(v.reasons, []);
    }
  });
});
