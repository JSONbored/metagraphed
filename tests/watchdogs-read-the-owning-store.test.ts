// A watchdog must measure the store that holds the rows (#10154).
//
// THE SHAPE OF THE BUG. Nine of these eleven watchdogs already WRITE their
// verdict through laneHealthStore -- that half of the port was done. None of
// them had moved its READ. So each one measured a D1 copy that stopped
// advancing the day its lane inverted, and every table they measure is in
// NEON_SOLE_STORE_TABLES.
//
// That is worse than a watchdog that is merely broken. A staleness watchdog
// keyed to MAX(captured_at) over a frozen table reports the age growing by one
// second per second, forever -- so it alarms permanently, on lanes that are
// fine, and the alarm cannot be distinguished from a real one. lane-alarm is
// the reader that turns those verdicts into GitHub issues.
//
// WHAT IS ASSERTED, and why it is not weaker than it looks. There is no
// Postgres here, so a watchdog that reaches the store fails at the query and
// degrades to a summary -- which is what these are built to do. What separates
// the two outcomes is the REASON: "no store bound" means it never tried, and
// anything else means it got as far as a store. With D1 unbound and Neon
// owning the tables, "never tried" is exactly the bug.
//
// The second case in each pair is what stops that from passing vacuously: with
// NOTHING bound, the refusal must still be there.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { runNeuronsStalenessWatchdog } from "../src/neurons-staleness-watchdog.ts";
import { runAccountBalancesStalenessWatchdog } from "../src/account-balances-staleness-watchdog.ts";
import { runHotkeyAlphaStalenessWatchdog } from "../src/hotkey-alpha-staleness-watchdog.ts";
import { runNominatorPositionsStalenessWatchdog } from "../src/nominator-positions-staleness-watchdog.ts";
import { runChainDetailStalenessWatchdog } from "../src/chain-detail-staleness-watchdog.ts";
import { runLaneAlarm } from "../src/lane-alarm.ts";

const HYPERDRIVE = { connectionString: "postgresql://example/db" };

/** Each watchdog, the tables it reads, and the refusal it gives with no store.
 *  The table list is the one the module hands readStore -- if they ever
 *  disagree, the "owns" case below stops being an owns case and the test fails
 *  rather than passing on the wrong branch. */
const WATCHDOGS: {
  name: string;
  run: (env: unknown, deps?: never) => Promise<{ reason?: string }>;
  tables: string[];
  refusal: string;
}[] = [
  {
    name: "neurons",
    run: (env) => runNeuronsStalenessWatchdog(env as never),
    tables: ["neurons"],
    refusal: "no store bound",
  },
  {
    name: "account-balances",
    run: (env) => runAccountBalancesStalenessWatchdog(env as never),
    tables: ["account_balances"],
    refusal: "no store bound",
  },
  {
    name: "hotkey-alpha",
    run: (env) => runHotkeyAlphaStalenessWatchdog(env as never),
    tables: ["hotkey_alpha", "nominator_positions"],
    refusal: "no store bound",
  },
  {
    name: "nominator-positions",
    run: (env) => runNominatorPositionsStalenessWatchdog(env as never),
    tables: ["nominator_positions"],
    refusal: "no store bound",
  },
  {
    name: "chain-detail",
    run: (env) => runChainDetailStalenessWatchdog(env as never),
    tables: ["chain_detail_blocks"],
    refusal: "no store bound",
  },
  {
    name: "lane-alarm",
    run: (env) => runLaneAlarm(env as never),
    tables: ["lane_health"],
    refusal: "no lane_health store bound",
  },
];

describe("with Neon owning its tables and no D1 bound", () => {
  for (const { name, run, refusal } of WATCHDOGS) {
    test(`${name} reaches a store`, async () => {
      const result = await run({
        HYPERDRIVE,
      });
      assert.notEqual(
        result.reason,
        refusal,
        `${name} refused to run: its read is still keyed to the D1 binding, ` +
          `so it measures a table that stopped advancing when the lane inverted`,
      );
    });
  }
});

describe("with nothing bound at all", () => {
  for (const { name, run, refusal } of WATCHDOGS) {
    test(`${name} still refuses`, async () => {
      // Without this, every assertion above would also pass if the store check
      // had simply been deleted -- a watchdog that runs against no store at all
      // and reports whatever a missing database returns.
      const result = await run({});
      assert.equal(result.reason, refusal, name);
    });
  }
});
