import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildCounterparties,
  buildCounterpartyRelationship,
  COUNTERPARTIES_SCAN_CAP,
  COUNTERPARTY_RELATIONSHIP_SCAN_CAP,
} from "../src/counterparties.ts";

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

  test("coerces a numeric-string block_number into last_block and its tie-break (#2413)", () => {
    // D1 can return an INTEGER column as a numeric string; last_block must still
    // populate (matching buildCounterpartyRelationship) so the equal-volume
    // tie-break prefers the more recent counterparty instead of collapsing to 0.
    const data = buildCounterparties(
      [
        { hotkey: "ME", coldkey: "OLD", amount_tao: 100, block_number: "5" },
        { hotkey: "ME", coldkey: "NEW", amount_tao: 100, block_number: "9" },
      ],
      ME,
      { limit: 20 },
    );
    const newer = data.counterparties.find((c) => c.address === "NEW");
    const older = data.counterparties.find((c) => c.address === "OLD");
    assert.equal(newer.last_block, 9);
    assert.equal(older.last_block, 5);
    // Equal volume (100 each) -> the newer last_block ranks first.
    assert.equal(data.counterparties[0].address, "NEW");
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

  test("skips rows not involving the account and rows with a null/blank amount", () => {
    const data = buildCounterparties(
      [
        { hotkey: "ME", coldkey: "A", amount_tao: null, block_number: 1 },
        { hotkey: "ME", coldkey: "B", amount_tao: "", block_number: 2 },
        { hotkey: "ME", coldkey: "C", amount_tao: "   ", block_number: 3 },
        { hotkey: "X", coldkey: "Y", amount_tao: 5, block_number: 4 }, // ME absent
      ],
      ME,
      {},
    );
    assert.equal(data.counterparty_count, 0);
    assert.equal(data.total_sent_tao, 0);
    assert.equal(data.total_received_tao, 0);
    assert.deepEqual(data.counterparties, []);
  });

  test("blank amount rows do not inflate transfer_count in the leaderboard rollup", () => {
    // buildCounterpartyRelationship already skips blank amounts (#3044); the
    // top-counterparties rollup must not count them as phantom 0-TAO transfers.
    for (const blank of ["", "   "]) {
      const data = buildCounterparties(
        [
          { hotkey: "ME", coldkey: "A", amount_tao: blank, block_number: 5 },
          { hotkey: "ME", coldkey: "A", amount_tao: 10, block_number: 6 },
        ],
        ME,
        {},
      );
      assert.equal(
        data.counterparty_count,
        1,
        `counterparty_count for ${JSON.stringify(blank)}`,
      );
      assert.equal(
        data.counterparties[0].transfer_count,
        1,
        `transfer_count for ${JSON.stringify(blank)}`,
      );
      assert.equal(data.counterparties[0].sent_tao, 10);
    }
    const zero = buildCounterparties(
      [{ hotkey: "ME", coldkey: "A", amount_tao: 0, block_number: 7 }],
      ME,
      {},
    );
    assert.equal(zero.counterparties[0].transfer_count, 1);
    assert.equal(zero.counterparties[0].sent_tao, 0);
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

  test("sums amounts in exact rao space, not float (no accumulated drift)", () => {
    // 1000 transfers of a 9-dp amount whose scaled rao is exactly representable
    // (123456.789012345 * 1e9 = 123456789012345 < 2^53). Summing them in float
    // TAO space drifts (the running sum crosses 2^53 scaled), so the naive
    // `+=` version reports 123456789.012343466 — off by 1535 rao from the true
    // integer-rao total 123456789.012345. Mirrors #2933.
    const amount = 123456.789012345;
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      hotkey: ME,
      coldkey: "A",
      amount_tao: amount,
      block_number: i + 1,
    }));
    const data = buildCounterparties(rows, ME, { limit: 5 });
    // Exact: 1000 * round(amount * 1e9) rao = 123456789012345000 rao.
    assert.equal(data.total_sent_tao, 123456789.012345);
    assert.equal(data.counterparties[0].sent_tao, 123456789.012345);
    // The naive float accumulation would have produced this drifted value.
    let floatSum = 0;
    for (const row of rows) floatSum += row.amount_tao;
    assert.notEqual(Math.round(floatSum * 1e9) / 1e9, 123456789.012345);
  });
});

describe("buildCounterpartyRelationship", () => {
  test("sums amounts in exact rao space, not float (no accumulated drift)", () => {
    // Same drift construction as buildCounterparties: 1000 sends of a 9-dp amount
    // whose float running-sum drifts past rao precision. The rao-exact total is
    // 123456789.012345; the naive `+=` version drifts to 123456789.012343466.
    const amount = 123456.789012345;
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      block_number: i + 1,
      event_index: 0,
      hotkey: ME,
      coldkey: "A",
      netuid: 1,
      amount_tao: amount,
      observed_at: 1_700_000_000_000,
    }));
    const data = buildCounterpartyRelationship(rows, ME, "A", { limit: 5 });
    assert.equal(data.total_sent_tao, 123456789.012345);
    // All 1000 rows are sends (ME → A), so net = received - sent is negative.
    assert.equal(data.net_tao, -123456789.012345);
    let floatSum = 0;
    for (const row of rows) floatSum += row.amount_tao;
    assert.notEqual(Math.round(floatSum * 1e9) / 1e9, 123456789.012345);
  });

  test("cold / empty / non-array rows yield a schema-stable empty relationship", () => {
    for (const rows of [[], null, undefined]) {
      const data = buildCounterpartyRelationship(rows, ME, "A", {});
      assert.equal(data.ss58, ME);
      assert.equal(data.counterparty, "A");
      assert.equal(data.transfer_count, 0);
      assert.equal(data.transfers_scanned, 0);
      assert.equal(data.scan_capped, false);
      assert.equal(data.total_sent_tao, 0);
      assert.equal(data.total_received_tao, 0);
      assert.equal(data.net_tao, 0);
      assert.equal(data.first_block, null);
      assert.equal(data.last_block, null);
      assert.deepEqual(data.transfers, []);
    }
  });

  test("summarizes one pair and preserves newest-first transfer evidence", () => {
    const data = buildCounterpartyRelationship(
      [
        {
          block_number: 12,
          event_index: 2,
          hotkey: "A",
          coldkey: "ME",
          netuid: "7",
          amount_tao: 30,
          observed_at: Date.UTC(2026, 5, 3),
        },
        {
          block_number: 10,
          event_index: 1,
          hotkey: "ME",
          coldkey: "A",
          netuid: null,
          amount_tao: 100,
          observed_at: Date.UTC(2026, 5, 1),
        },
        {
          block_number: 9,
          event_index: 1,
          hotkey: "ME",
          coldkey: "B",
          amount_tao: 5,
        },
      ],
      ME,
      "A",
      { limit: 10 },
    );
    assert.equal(data.transfer_count, 2);
    assert.equal(data.transfers_scanned, 3);
    assert.equal(data.total_sent_tao, 100);
    assert.equal(data.total_received_tao, 30);
    assert.equal(data.net_tao, -70);
    assert.equal(data.first_block, 10);
    assert.equal(data.last_block, 12);
    assert.equal(data.first_seen_at, "2026-06-01T00:00:00.000Z");
    assert.equal(data.last_seen_at, "2026-06-03T00:00:00.000Z");
    assert.equal(data.transfers[0].direction, "received");
    assert.equal(data.transfers[0].netuid, 7);
    assert.equal(data.transfers[0].from, "A");
    assert.equal(data.transfers[0].to, ME);
    assert.equal(data.transfers[1].direction, "sent");
  });

  test("does not summarize same-address relationships", () => {
    const data = buildCounterpartyRelationship(
      [
        {
          block_number: 12,
          event_index: 2,
          hotkey: ME,
          coldkey: ME,
          netuid: 7,
          amount_tao: 30,
          observed_at: Date.UTC(2026, 5, 3),
        },
      ],
      ME,
      ME,
      { limit: 10 },
    );
    assert.equal(data.transfer_count, 0);
    assert.equal(data.transfers_scanned, 1);
    assert.equal(data.total_sent_tao, 0);
    assert.equal(data.total_received_tao, 0);
    assert.deepEqual(data.transfers, []);
  });

  test("skips malformed transfer amounts without poisoning totals", () => {
    const data = buildCounterpartyRelationship(
      [
        {
          block_number: "not-a-block",
          event_index: -1,
          hotkey: ME,
          coldkey: "A",
          netuid: undefined,
          amount_tao: "bad",
          observed_at: "not-a-date",
        },
      ],
      ME,
      "A",
      {},
    );
    assert.equal(data.transfer_count, 0);
    assert.equal(data.transfers_scanned, 1);
    assert.equal(data.total_sent_tao, 0);
    assert.equal(data.first_block, null);
    assert.equal(data.last_block, null);
    assert.equal(data.first_seen_at, null);
    assert.equal(data.last_seen_at, null);
    assert.deepEqual(data.transfers, []);
  });

  test("blank integer evidence cells stay null on relationship transfers (not 0)", () => {
    for (const blank of ["", "   "]) {
      const data = buildCounterpartyRelationship(
        [
          {
            block_number: blank,
            event_index: blank,
            hotkey: ME,
            coldkey: "A",
            netuid: blank,
            amount_tao: 1,
            observed_at: Date.UTC(2026, 5, 1),
          },
        ],
        ME,
        "A",
        {},
      );
      assert.equal(
        data.transfer_count,
        1,
        `transfer_count for ${JSON.stringify(blank)}`,
      );
      assert.equal(
        data.transfers[0].block_number,
        null,
        `block_number for ${JSON.stringify(blank)}`,
      );
      assert.equal(
        data.transfers[0].event_index,
        null,
        `event_index for ${JSON.stringify(blank)}`,
      );
      assert.equal(
        data.transfers[0].netuid,
        null,
        `netuid for ${JSON.stringify(blank)}`,
      );
      assert.equal(data.last_block, null);
    }
  });

  test("blank amount_tao cells stay null on relationship transfers (not 0 TAO)", () => {
    // Mirrors the blank-cell guard in account-events.mjs (#3031): Number("") is 0.
    for (const blank of ["", "   "]) {
      const data = buildCounterpartyRelationship(
        [
          {
            block_number: 5,
            event_index: 0,
            hotkey: ME,
            coldkey: "A",
            netuid: 1,
            amount_tao: blank,
            observed_at: Date.UTC(2026, 5, 1),
          },
          {
            block_number: 6,
            event_index: 0,
            hotkey: ME,
            coldkey: "A",
            netuid: 1,
            amount_tao: 2,
            observed_at: Date.UTC(2026, 5, 2),
          },
        ],
        ME,
        "A",
        {},
      );
      assert.equal(
        data.transfer_count,
        1,
        `transfer_count for amount ${JSON.stringify(blank)}`,
      );
      assert.equal(data.total_sent_tao, 2);
      assert.equal(data.transfers.length, 1);
      assert.equal(data.transfers[0].amount_tao, 2);
    }
    const missing = buildCounterpartyRelationship(
      [
        {
          block_number: 8,
          event_index: 0,
          hotkey: ME,
          coldkey: "A",
          netuid: 1,
          amount_tao: null,
          observed_at: Date.UTC(2026, 5, 4),
        },
        {
          block_number: 9,
          event_index: 0,
          hotkey: ME,
          coldkey: "A",
          netuid: 1,
          amount_tao: 3,
          observed_at: Date.UTC(2026, 5, 5),
        },
      ],
      ME,
      "A",
      {},
    );
    assert.equal(missing.transfer_count, 1);
    assert.equal(missing.total_sent_tao, 3);
    assert.equal(missing.transfers.length, 1);
    assert.equal(missing.transfers[0].amount_tao, 3);
    const zero = buildCounterpartyRelationship(
      [
        {
          block_number: 7,
          event_index: 0,
          hotkey: ME,
          coldkey: "A",
          netuid: 1,
          amount_tao: 0,
          observed_at: Date.UTC(2026, 5, 3),
        },
      ],
      ME,
      "A",
      {},
    );
    assert.equal(zero.transfer_count, 1);
    assert.equal(zero.transfers[0].amount_tao, 0);
  });

  test("skips sparse pair rows while preserving valid string and null evidence cells", () => {
    const data = buildCounterpartyRelationship(
      [
        null,
        { hotkey: null, coldkey: "A", amount_tao: 5 },
        { hotkey: ME, coldkey: null, amount_tao: 5 },
        {
          block_number: null,
          event_index: null,
          hotkey: ME,
          coldkey: "A",
          netuid: "7",
          amount_tao: "2.5",
          observed_at: Date.UTC(2026, 5, 1),
        },
        {
          block_number: "not-a-block",
          event_index: -1,
          hotkey: ME,
          coldkey: "A",
          netuid: "not-a-netuid",
          amount_tao: 3,
          observed_at: "not-a-date",
        },
        {
          block_number: 5,
          event_index: 1,
          hotkey: "A",
          coldkey: ME,
          netuid: 7,
          amount_tao: "7.5",
          observed_at: String(Date.UTC(2026, 5, 2)),
        },
        {
          block_number: 6,
          event_index: 2,
          hotkey: ME,
          coldkey: "A",
          netuid: 8,
          amount_tao: "",
          observed_at: "not-a-date",
        },
      ],
      ME,
      "A",
      {},
    );
    assert.equal(data.transfers_scanned, 7);
    assert.equal(data.transfer_count, 3);
    assert.equal(data.total_sent_tao, 5.5);
    assert.equal(data.total_received_tao, 7.5);
    assert.equal(data.first_block, 5);
    assert.equal(data.last_block, 5);
    assert.equal(data.first_seen_at, "2026-06-01T00:00:00.000Z");
    assert.equal(data.last_seen_at, "2026-06-02T00:00:00.000Z");
    assert.equal(data.transfers[0].amount_tao, 2.5);
    assert.equal(data.transfers[0].event_index, null);
    assert.equal(data.transfers[0].netuid, 7);
    assert.equal(data.transfers[1].amount_tao, 3);
    assert.equal(data.transfers[1].block_number, null);
    assert.equal(data.transfers[1].event_index, null);
    assert.equal(data.transfers[1].netuid, null);
    assert.equal(data.transfers[1].observed_at, null);
    assert.equal(data.transfers[2].amount_tao, 7.5);
  });

  test("blank or out-of-range observed_at cells stay null on relationship evidence (not epoch 1970)", () => {
    const data = buildCounterpartyRelationship(
      [
        {
          block_number: 1,
          event_index: 0,
          hotkey: ME,
          coldkey: "A",
          netuid: 1,
          amount_tao: 1,
          observed_at: null,
        },
        {
          block_number: 2,
          event_index: 0,
          hotkey: ME,
          coldkey: "A",
          netuid: 1,
          amount_tao: 1,
          observed_at: "",
        },
        {
          block_number: 3,
          event_index: 0,
          hotkey: ME,
          coldkey: "A",
          netuid: 1,
          amount_tao: 1,
          observed_at: "   ",
        },
        {
          block_number: 4,
          event_index: 0,
          hotkey: ME,
          coldkey: "A",
          netuid: 1,
          amount_tao: 1,
          observed_at: "8640000000000001",
        },
      ],
      ME,
      "A",
      {},
    );
    assert.equal(data.transfer_count, 4);
    assert.equal(data.first_seen_at, null);
    assert.equal(data.last_seen_at, null);
    assert.equal(data.transfers[0].observed_at, null);
    assert.equal(data.transfers[1].observed_at, null);
    assert.equal(data.transfers[2].observed_at, null);
    assert.equal(data.transfers[3].observed_at, null);
  });

  test("coerces string-typed observed_at cells on relationship last_seen_at", () => {
    const ts = String(Date.UTC(2026, 5, 2));
    const data = buildCounterpartyRelationship(
      [
        {
          block_number: 1,
          event_index: 0,
          hotkey: ME,
          coldkey: "A",
          netuid: 1,
          amount_tao: 1,
          observed_at: ts,
        },
      ],
      ME,
      "A",
      {},
    );
    assert.equal(
      data.last_seen_at,
      new Date(Date.UTC(2026, 5, 2)).toISOString(),
    );
    assert.equal(data.transfers[0].observed_at, data.last_seen_at);
  });

  test("limits evidence rows while summary counts the full bounded scan", () => {
    const rows = Array.from(
      { length: COUNTERPARTY_RELATIONSHIP_SCAN_CAP },
      (_, i) => ({
        block_number: i,
        event_index: 0,
        hotkey: "ME",
        coldkey: "A",
        amount_tao: 1,
      }),
    );
    const data = buildCounterpartyRelationship(rows, ME, "A", { limit: 2 });
    assert.equal(data.transfer_count, COUNTERPARTY_RELATIONSHIP_SCAN_CAP);
    assert.equal(data.scan_capped, true);
    assert.equal(data.first_block, null);
    assert.equal(data.first_seen_at, null);
    assert.equal(data.total_sent_tao, COUNTERPARTY_RELATIONSHIP_SCAN_CAP);
    assert.equal(data.transfers.length, 2);
  });
});

describe("buildCounterparties — invariants", () => {
  const ROWS = [
    { hotkey: "ME", coldkey: "A", amount_tao: 100, block_number: 5 },
    { hotkey: "A", coldkey: "ME", amount_tao: 40, block_number: 6 },
    { hotkey: "B", coldkey: "ME", amount_tao: 25, block_number: 7 },
    { hotkey: "ME", coldkey: "C", amount_tao: 10, block_number: 8 },
    { hotkey: "ME", coldkey: "ME", amount_tao: 99, block_number: 9 }, // self (ignored)
  ];

  test("per-counterparty net = received − sent, and the rollup sums to the totals", () => {
    const data = buildCounterparties(ROWS, ME, { limit: 100 });
    let sumSent = 0;
    let sumReceived = 0;
    let sumCount = 0;
    for (const cp of data.counterparties) {
      // net is exactly received − sent (integer amounts → no rounding drift).
      assert.equal(cp.net_tao, cp.received_tao - cp.sent_tao);
      sumSent += cp.sent_tao;
      sumReceived += cp.received_tao;
      sumCount += cp.transfer_count;
    }
    // Σ per-counterparty == the summary totals (the rollup is self-consistent).
    assert.equal(sumSent, data.total_sent_tao);
    assert.equal(sumReceived, data.total_received_tao);
    // Σ transfer_count == the involved (non-self) transfers.
    assert.equal(sumCount, 4);
    assert.equal(data.counterparty_count, 3);
  });

  test("the list is monotonically non-increasing by total volume", () => {
    const data = buildCounterparties(
      [
        { hotkey: "ME", coldkey: "A", amount_tao: 5, block_number: 1 },
        { hotkey: "ME", coldkey: "B", amount_tao: 50, block_number: 2 },
        { hotkey: "ME", coldkey: "C", amount_tao: 500, block_number: 3 },
      ],
      ME,
      { limit: 100 },
    );
    for (let i = 1; i < data.counterparties.length; i += 1) {
      const prev = data.counterparties[i - 1];
      const cur = data.counterparties[i];
      assert.ok(
        prev.sent_tao + prev.received_tao >= cur.sent_tao + cur.received_tao,
      );
    }
  });

  test("output amounts stay finite even when a sum overflows (defensive round guard)", () => {
    // Two MAX_VALUE sends overflow to Infinity; round() clamps to 0 rather than
    // leaking Infinity/NaN into the JSON — and exercises round's non-finite branch.
    const data = buildCounterparties(
      [
        {
          hotkey: "ME",
          coldkey: "A",
          amount_tao: Number.MAX_VALUE,
          block_number: 1,
        },
        {
          hotkey: "ME",
          coldkey: "A",
          amount_tao: Number.MAX_VALUE,
          block_number: 2,
        },
      ],
      ME,
      { limit: 100 },
    );
    assert.equal(data.counterparties[0].sent_tao, 0);
    assert.equal(data.total_sent_tao, 0);
    assert.ok(Number.isFinite(data.counterparties[0].net_tao));
  });
});

describe("buildCounterparties — regressions", () => {
  test("equal-volume counterparties tie-break by last_block desc, then address asc", () => {
    // Equal volume (10 each); A's last block is newer → A ranks first.
    const byBlock = buildCounterparties(
      [
        { hotkey: "ME", coldkey: "A", amount_tao: 10, block_number: 20 },
        { hotkey: "ME", coldkey: "B", amount_tao: 10, block_number: 10 },
      ],
      ME,
      { limit: 100 },
    );
    assert.deepEqual(
      byBlock.counterparties.map((c) => c.address),
      ["A", "B"],
    );
    // Equal volume AND equal last_block → deterministic address-ascending order.
    const byAddress = buildCounterparties(
      [
        { hotkey: "ME", coldkey: "B", amount_tao: 10, block_number: 5 },
        { hotkey: "ME", coldkey: "A", amount_tao: 10, block_number: 5 },
      ],
      ME,
      { limit: 100 },
    );
    assert.deepEqual(
      byAddress.counterparties.map((c) => c.address),
      ["A", "B"],
    );
  });

  test("a transfer with an empty counterparty address is skipped", () => {
    const data = buildCounterparties(
      [
        { hotkey: "ME", coldkey: "", amount_tao: 10, block_number: 1 }, // empty 'to'
        { hotkey: "ME", coldkey: "A", amount_tao: 5, block_number: 2 },
      ],
      ME,
      {},
    );
    assert.equal(data.counterparty_count, 1);
    assert.equal(data.counterparties[0].address, "A");
  });

  test("a null block_number leaves last_block null", () => {
    const data = buildCounterparties(
      [{ hotkey: "ME", coldkey: "A", amount_tao: 5, block_number: null }],
      ME,
      {},
    );
    assert.equal(data.counterparties[0].last_block, null);
  });

  test("blank block_number cells leave last_block null (not block 0)", () => {
    // Mirrors the blank-cell guard in blocks.mjs (#2947): Number("") is 0.
    for (const blank of ["", "   "]) {
      const data = buildCounterparties(
        [{ hotkey: "ME", coldkey: "A", amount_tao: 5, block_number: blank }],
        ME,
        {},
      );
      assert.equal(
        data.counterparties[0].last_block,
        null,
        `last_block for ${JSON.stringify(blank)}`,
      );
    }
  });

  test("tie-break is deterministic when volumes tie AND last_block is null", () => {
    // B is inserted first; A and B tie on volume with null last_block. Exercises
    // both (last_block ?? 0) fallbacks and the address tiebreak's b<a (else) side,
    // and the result is still address-ascending.
    const data = buildCounterparties(
      [
        { hotkey: "ME", coldkey: "C", amount_tao: 10, block_number: null },
        { hotkey: "ME", coldkey: "A", amount_tao: 10, block_number: null },
        { hotkey: "ME", coldkey: "B", amount_tao: 10, block_number: null },
      ],
      ME,
      { limit: 100 },
    );
    assert.deepEqual(
      data.counterparties.map((c) => c.address),
      ["A", "B", "C"],
    );
  });

  test("a null / garbage row in the scan is skipped without throwing", () => {
    const data = buildCounterparties(
      [
        null,
        { hotkey: "ME", coldkey: "A", amount_tao: 5, block_number: 1 },
        undefined,
      ],
      ME,
      {},
    );
    assert.equal(data.counterparty_count, 1);
    assert.equal(data.counterparties[0].address, "A");
  });

  test("a transfer missing the counterparty's address (either side) is skipped", () => {
    const data = buildCounterparties(
      [
        { hotkey: "ME", coldkey: null, amount_tao: 10, block_number: 1 }, // send, null 'to'
        { hotkey: null, coldkey: "ME", amount_tao: 5, block_number: 2 }, // receive, null 'from'
        { hotkey: "ME", coldkey: "", amount_tao: 7, block_number: 3 }, // send, empty 'to'
        { hotkey: "", coldkey: "ME", amount_tao: 9, block_number: 4 }, // receive, empty 'from'
        { hotkey: "ME", coldkey: "A", amount_tao: 3, block_number: 5 },
      ],
      ME,
      {},
    );
    assert.equal(data.counterparty_count, 1); // only A survives
    assert.equal(data.counterparties[0].address, "A");
  });

  test("limit is defensively clamped to [1, 100]", () => {
    const rows = Array.from({ length: 150 }, (_, i) => ({
      hotkey: "ME",
      coldkey: `P${i}`,
      amount_tao: 150 - i,
      block_number: i,
    }));
    // The handler clamps already; the builder re-clamps defensively.
    assert.equal(
      buildCounterparties(rows, ME, { limit: 0 }).counterparties.length,
      1,
    );
    assert.equal(
      buildCounterparties(rows, ME, { limit: 999 }).counterparties.length,
      100,
    );
  });
});

// loadCounterparties/loadCounterpartyRelationship (the D1-querying
// account_events readers) were deleted (2026-07-17, D1 fully eliminated) --
// see src/counterparties.ts's own comment. buildCounterparties/
// buildCounterpartyRelationship coverage above already exercises the same
// rollup/relationship logic directly against hand-built rows.
