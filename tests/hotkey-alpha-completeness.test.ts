// The hotkey_alpha completeness gate (#9502), against a REAL SQLite database
// built from the migration it reads.
//
// The twin of tests/account-balances-completeness.test.ts, guarding a quieter
// failure. A partial balance ledger drops accounts out of a leaderboard, which
// is at least a visible hole. A partial POOL ledger prices the positions naming
// it against nothing, so those coldkeys' delegated_tao comes out merely too LOW
// -- a ranking that stays well-formed and plausible while being wrong.
//
// And no count can recover completeness here even in principle: the producer
// SKIPS a genuine zero pool rather than writing a zero row, so a missing
// (hotkey, netuid) means either "scanned, empty" or "never scanned". So the
// assertions below are about what the gate REFUSES.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, test } from "vitest";
import {
  latestCompleteHotkeyAlphaPass,
  mayPriceHotkeyAlpha,
} from "../src/hotkey-alpha-completeness.ts";

const SCHEMA = fs.readFileSync(
  path.join(process.cwd(), "migrations/d1/0021_hotkey_alpha_passes.sql"),
  "utf8",
);

let db: InstanceType<typeof DatabaseSync>;

/** The D1 shim shape this reader uses: prepare().first(). */
function d1() {
  return {
    prepare(sql: string) {
      return {
        async first() {
          return db.prepare(sql).get() ?? null;
        },
      };
    },
  };
}

function insertPass(
  capturedAt: number,
  expected: number,
  received: number,
  completedAt: number | null,
) {
  db.prepare(
    `INSERT INTO hotkey_alpha_passes
       (captured_at, expected_rows, received_rows, completed_at)
     VALUES (?, ?, ?, ?)`,
  ).run(capturedAt, expected, received, completedAt);
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
});

describe("latestCompleteHotkeyAlphaPass", () => {
  test("declines while no pass has completed", async () => {
    const result = await latestCompleteHotkeyAlphaPass(d1());
    assert.equal(result.capturedAt, null);
    assert.equal(result.reason, "no_complete_pass");
    assert.equal(mayPriceHotkeyAlpha(result), false);
  });

  test("declines on an IN-FLIGHT pass, however many rows have landed", async () => {
    // THE REGRESSION SHAPE. Rows are present and every one is correct; the
    // pass simply has not finished. Pricing over it underprices silently.
    insertPass(1_785_910_000_000, 148_211, 140_000, null);
    const result = await latestCompleteHotkeyAlphaPass(d1());
    assert.equal(result.capturedAt, null);
    assert.equal(mayPriceHotkeyAlpha(result), false);
  });

  test("prices once a pass is recorded complete", async () => {
    insertPass(1_785_910_000_000, 148_211, 148_211, 1_785_910_500_000);
    const result = await latestCompleteHotkeyAlphaPass(d1());
    assert.equal(result.capturedAt, 1_785_910_000_000);
    assert.equal(result.expectedRows, 148_211);
    assert.equal(result.receivedRows, 148_211);
    assert.equal(result.reason, null);
    assert.equal(mayPriceHotkeyAlpha(result), true);
  });

  test("an at-least-once replay does not un-complete a pass", async () => {
    // The producer re-sends a chunk on failure, so received_rows can exceed
    // expected_rows. Keying on completed_at rather than on equality is what
    // keeps that from reading as unfinished.
    insertPass(1_785_910_000_000, 148_211, 153_211, 1_785_910_500_000);
    const result = await latestCompleteHotkeyAlphaPass(d1());
    assert.equal(mayPriceHotkeyAlpha(result), true);
    assert.equal(result.receivedRows, 153_211);
  });

  test("takes the NEWEST complete pass, not merely any complete one", async () => {
    insertPass(1_785_900_000_000, 100, 100, 1_785_900_500_000);
    insertPass(1_785_910_000_000, 200, 200, 1_785_910_500_000);
    // An in-flight pass newer than both must not displace the complete one.
    insertPass(1_785_920_000_000, 300, 10, null);
    const result = await latestCompleteHotkeyAlphaPass(d1());
    assert.equal(result.capturedAt, 1_785_910_000_000);
  });

  test("declines on an unbound DB", async () => {
    for (const bad of [null, undefined, {} as never]) {
      const result = await latestCompleteHotkeyAlphaPass(bad);
      assert.equal(result.reason, "unavailable");
      assert.equal(mayPriceHotkeyAlpha(result), false);
    }
  });

  test("an unreadable passes table declines rather than pricing blind", async () => {
    // Migrations are applied by hand, so "the table is not there yet" is a real
    // state -- and it means the same thing as an unfinished pass.
    const throwing = {
      prepare() {
        return {
          async first(): Promise<unknown> {
            throw new Error("no such table: hotkey_alpha_passes");
          },
        };
      },
    };
    const result = await latestCompleteHotkeyAlphaPass(throwing);
    assert.equal(result.reason, "unavailable");
    assert.equal(mayPriceHotkeyAlpha(result), false);
  });

  test("a garbage captured_at is refused rather than trusted", async () => {
    // completed_at is set but the key is nonsense: scoping a price read to it
    // would match no pool rows at all and value every position at nothing.
    insertPass(0, 10, 10, 1_785_910_500_000);
    const result = await latestCompleteHotkeyAlphaPass(d1());
    assert.equal(result.capturedAt, null);
    assert.equal(mayPriceHotkeyAlpha(result), false);
  });

  test("a complete pass with unreadable counts still prices", async () => {
    // The counts are reporting, not the gate: completed_at is the fact.
    insertPass(1_785_910_000_000, 0, 0, 1_785_910_500_000);
    const result = await latestCompleteHotkeyAlphaPass(d1());
    assert.equal(mayPriceHotkeyAlpha(result), true);
    assert.equal(result.expectedRows, null);
    assert.equal(result.receivedRows, null);
  });
});
