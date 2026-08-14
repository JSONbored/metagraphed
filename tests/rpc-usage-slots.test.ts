// The AE slot map, which infra vendors and its exporter reads (#11078).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "vitest";
import { GENERATED_PATH, render } from "../scripts/generate-rpc-usage-slots.ts";
import {
  RPC_USAGE_BLOBS,
  RPC_USAGE_DOUBLES,
} from "../src/rpc-usage-capture.ts";
import { repoRoot } from "../scripts/lib.ts";

interface Slot {
  name: string;
  slot: string;
  column: string | null;
}
const emitted = JSON.parse(render()) as {
  dataset: string;
  blobs: Slot[];
  doubles: Slot[];
};
const all = [...emitted.blobs, ...emitted.doubles];

describe("rpc-usage slot map", () => {
  test("every declared slot is emitted", () => {
    // Vacuity guard: an emitter that produced nothing would satisfy every
    // other assertion here.
    const declared =
      Object.keys(RPC_USAGE_BLOBS).length +
      Object.keys(RPC_USAGE_DOUBLES).length;
    assert.ok(declared > 0, "the source declares no slots");
    assert.equal(all.length, declared);
  });

  test("no slot is used twice", () => {
    // A reused slot averages two different quantities together, and AE data
    // points cannot be migrated to separate them again.
    const slots = all.map((s) => s.slot);
    assert.equal(new Set(slots).size, slots.length);
  });

  test("slots are ordered by index, so an append is visible in the diff", () => {
    for (const group of [emitted.blobs, emitted.doubles]) {
      const nums = group.map((s) => Number(s.slot.replace(/^\D+/, "")));
      assert.deepEqual(
        nums,
        [...nums].sort((a, b) => a - b),
      );
    }
  });

  test("camelCase names carry their snake_case lakehouse column", () => {
    const byName = new Map(all.map((s) => [s.name, s.column]));
    assert.equal(byName.get("endpointId"), "endpoint_id");
    assert.equal(byName.get("latencyMs"), "latency_ms");
    assert.equal(byName.get("network"), "network");
  });

  test("pool has no column: it is a filter, not a field", () => {
    // The lakehouse table predates the public/fullnode discriminator, so the
    // exporter filters on it and must never write it -- exporting both pools
    // would fold a second population into a published series.
    const pool = all.find((s) => s.name === "pool");
    assert.ok(pool, "pool must still be declared");
    assert.equal(pool.column, null);
  });

  test("the committed artifact is what the source produces", () => {
    assert.equal(
      readFileSync(path.join(repoRoot, GENERATED_PATH), "utf8"),
      render(),
    );
  });
});
