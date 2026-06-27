import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildCounterparties,
  COUNTERPARTIES_SCAN_CAP,
} from "../src/counterparties.mjs";

const ME = "ME";

describe("buildCounterparties", () => {
  test("cold / empty / non-array rows yield a schema-stable empty rollup", () => {
    for (const rows of [[], null, undefined]) {
      const data = buildCounterparties(rows, ME, {});
      assert.equal(data.ss58, ME);
      assert.equal(data.counterparty_count, 0);
      assert.equal(data.transfers_scanned, 0);
      assert.equal(data.scan_capped, false);
      assert.equal(data.total_sent_tao, 0);
      assert.equal(data.total_received_tao, 0);
      assert.deepEqual(data.counterparties, []);
    }
  });

  test("aggregates sent + received per counterparty, ranked by volume", () => {
    const rows = [
      { hotkey: "ME", coldkey: "A", amount_tao: 100, block_number: 10 }, // ME→A
      { hotkey: "ME", coldkey: "B", amount_tao: 50, block_number: 9 }, // ME→B
      { hotkey: "A", coldkey: "ME", amount_tao: 30, block_number: 8 }, // A→ME
      { hotkey: "C", coldkey: "ME", amount_tao: 200, block_number: 7 }, // C→ME
    ];
    const data = buildCounterparties(rows, ME, { limit: 20 });
    assert.equal(data.counterparty_count, 3);
    assert.equal(data.transfers_scanned, 4);
    assert.equal(data.total_sent_tao, 150); // 100 + 50
    assert.equal(data.total_received_tao, 230); // 30 + 200
    assert.equal(data.counterparties.length, 3);
    // Ranked by total volume: C (200) > A (130) > B (50).
    assert.equal(data.counterparties[0].address, "C");
    assert.equal(data.counterparties[0].received_tao, 200);
    assert.equal(data.counterparties[0].sent_tao, 0);
    assert.equal(data.counterparties[0].net_tao, 200);
    const a = data.counterparties[1];
    assert.equal(a.address, "A");
    assert.equal(a.sent_tao, 100);
    assert.equal(a.received_tao, 30);
    assert.equal(a.net_tao, -70); // received − sent
    assert.equal(a.transfer_count, 2);
    assert.equal(a.last_block, 10); // newest of A's two transfers
    assert.equal(data.counterparties[2].address, "B");
  });

  test("skips self-transfers (account on both sides)", () => {
    const data = buildCounterparties(
      [
        { hotkey: "ME", coldkey: "ME", amount_tao: 10, block_number: 5 }, // self
        { hotkey: "ME", coldkey: "X", amount_tao: 20, block_number: 6 },
      ],
      ME,
      {},
    );
    assert.equal(data.counterparty_count, 1);
    assert.equal(data.counterparties[0].address, "X");
    assert.equal(data.total_sent_tao, 20); // the self-transfer contributes nothing
  });

  test("skips rows not involving the account and coerces a non-finite amount to 0", () => {
    const data = buildCounterparties(
      [
        { hotkey: "ME", coldkey: "A", amount_tao: null, block_number: 1 }, // amount → 0
        { hotkey: "X", coldkey: "Y", amount_tao: 5, block_number: 2 }, // ME absent
      ],
      ME,
      {},
    );
    assert.equal(data.counterparty_count, 1); // only A
    assert.equal(data.counterparties[0].address, "A");
    assert.equal(data.counterparties[0].sent_tao, 0);
  });

  test("limit caps the returned list but counterparty_count covers all", () => {
    const rows = [
      { hotkey: "ME", coldkey: "A", amount_tao: 100, block_number: 3 },
      { hotkey: "ME", coldkey: "B", amount_tao: 50, block_number: 2 },
      { hotkey: "ME", coldkey: "C", amount_tao: 10, block_number: 1 },
    ];
    const data = buildCounterparties(rows, ME, { limit: 2 });
    assert.equal(data.counterparty_count, 3);
    assert.equal(data.counterparties.length, 2);
    assert.equal(data.counterparties[0].address, "A"); // top by volume
    assert.equal(data.counterparties[1].address, "B");
  });

  test("flags scan_capped when the read hit the cap", () => {
    const rows = Array.from({ length: COUNTERPARTIES_SCAN_CAP }, (_, i) => ({
      hotkey: "ME",
      coldkey: `P${i}`,
      amount_tao: 1,
      block_number: i,
    }));
    const data = buildCounterparties(rows, ME, { limit: 10 });
    assert.equal(data.scan_capped, true);
    assert.equal(data.counterparty_count, COUNTERPARTIES_SCAN_CAP);
    assert.equal(data.counterparties.length, 10);
  });
});
