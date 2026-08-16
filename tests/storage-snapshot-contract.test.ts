// The storage-snapshot declaration, and the stream schema it derives (infra#452).
import assert from "node:assert/strict";
import { describe, test } from "vitest";

import { streamSchemaFrom } from "../src/pipeline-stream-contract.ts";
import {
  STORAGE_SNAPSHOT_ITEMS,
  STORAGE_SNAPSHOT_VERSION,
  StorageSnapshotRow,
  storageSnapshotKeys,
} from "../src/storage-snapshot-contract.ts";

describe("the row is what makes a reading evidence", () => {
  test("it derives a stream schema with the height and our clock separate", () => {
    // THE POINT OF DERIVING IT. Pipelines does not preserve order across
    // requests, so `height` is the only ordering that means anything and
    // `observed_at` must never stand in for it. Both are carried, both
    // required, and the stream schema says so without anyone hand-writing it.
    assert.deepEqual(streamSchemaFrom(StorageSnapshotRow), {
      fields: [
        { name: "pallet", type: "string", required: true },
        { name: "item", type: "string", required: true },
        { name: "key", type: "string", required: true },
        { name: "height", type: "int64", required: true },
        { name: "value", type: "string", required: true },
        { name: "observed_at", type: "int64", required: true },
      ],
    });
  });

  test("a plain storage value has an empty key, not a null one", () => {
    // A nullable key would make every unkeyed item a dropped row: the stream
    // has no null-vs-absent distinction, so `required: false` plus a null is
    // discarded at the sink with a 200 at the caller.
    const row = {
      pallet: "Balances",
      item: "TotalIssuance",
      key: "",
      height: 8_848_204,
      value: "0x00",
      observed_at: 1_786_884_000_000,
    };
    assert.equal(StorageSnapshotRow.safeParse(row).success, true);
    assert.equal(
      StorageSnapshotRow.safeParse({ ...row, key: null }).success,
      false,
    );
  });

  test("an unknown field is refused, because the sink would strip it", () => {
    const parsed = StorageSnapshotRow.safeParse({
      pallet: "Swap",
      item: "AlphaSqrtPrice",
      key: "0x01",
      height: 1,
      value: "0x02",
      observed_at: 1,
      netuid: 7,
    });
    assert.equal(parsed.success, false);
  });

  test("a negative height is not a height", () => {
    assert.equal(
      StorageSnapshotRow.safeParse({
        pallet: "Swap",
        item: "AlphaSqrtPrice",
        key: "",
        height: -1,
        value: "0x",
        observed_at: 1,
      }).success,
      false,
    );
  });
});

describe("the declaration", () => {
  test("every item names a pallet, an item, a cadence and a reason", () => {
    for (const entry of STORAGE_SNAPSHOT_ITEMS) {
      assert.ok(entry.pallet.length > 0, "pallet");
      assert.ok(entry.item.length > 0, "item");
      assert.ok(
        Number.isInteger(entry.everyMinutes) && entry.everyMinutes > 0,
        `${entry.pallet}.${entry.item} needs a positive cadence`,
      );
      // A cadence with no stated reason is a number nobody can audit, and this
      // lane's whole cost is cadence.
      assert.ok(
        entry.reason.length > 20,
        `${entry.pallet}.${entry.item} needs a reason for its cadence`,
      );
    }
  });

  test("it covers exactly the four pallets with no observed counterpart", () => {
    // Scoped deliberately. 361 items are unread; a list that tried to close
    // that in one move would price itself out of the poller's storage budget.
    // These four are where we already publish a DERIVED figure, so every row
    // is reconcilable from the first pass.
    assert.deepEqual(
      [...new Set(STORAGE_SNAPSHOT_ITEMS.map((i) => i.pallet))].sort(),
      ["Balances", "Commitments", "Crowdloan", "Swap"],
    );
  });

  test("no item is declared twice", () => {
    const keys = storageSnapshotKeys();
    assert.equal(
      keys.length,
      new Set(keys).size,
      "a duplicated item would be sampled twice and stored twice per height",
    );
  });

  test("keys are stable and sorted, so a diff reads as an addition", () => {
    assert.deepEqual(storageSnapshotKeys(), [
      "Balances.InactiveIssuance",
      "Balances.TotalIssuance",
      "Commitments.CommitmentOf",
      "Crowdloan.Crowdloans",
      "Swap.AlphaSqrtPrice",
      "Swap.SwapV3Initialized",
    ]);
  });

  test("the sort does not depend on the declared order", () => {
    // Non-vacuity: `storageSnapshotKeys` must actually sort, or two producers
    // reading the same list could schedule in different orders.
    assert.deepEqual(
      storageSnapshotKeys([
        { pallet: "Z", item: "b", everyMinutes: 1, reason: "x" },
        { pallet: "A", item: "a", everyMinutes: 1, reason: "x" },
      ]),
      ["A.a", "Z.b"],
    );
  });

  test("the version is an integer that can be bumped", () => {
    // It exists so a cadence change is visible to a reader comparing two
    // spans -- the rows themselves would not say the sampling moved.
    assert.ok(Number.isInteger(STORAGE_SNAPSHOT_VERSION));
    assert.ok(STORAGE_SNAPSHOT_VERSION >= 1);
  });
});
