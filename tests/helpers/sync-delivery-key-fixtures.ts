import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { syncDeliveryBytes } from "../../src/sync-delivery-receipt.ts";
import type { SyncBatchLane } from "../../src/sync-batch-queue.ts";

export interface DeliveryKeyFixture {
  lane: SyncBatchLane;
  keys: string[];
  valid: Record<string, unknown>;
  invalid: Record<string, unknown>[];
}
export const deliveryKeyFixtures = JSON.parse(
  readFileSync("tests/fixtures/sync-delivery-v1-keys.json", "utf8"),
) as DeliveryKeyFixture[];

/** Reproduce the original unchecked protocol for adversarial input. A digest
 * mismatch must not be the reason a storage-key alias is refused. */
export function uncheckedDelivery(
  fixture: DeliveryKeyFixture,
  rows: Record<string, unknown>[],
  capturedAt: number,
  total = 2,
) {
  const identity = [
    "metagraph-sync-delivery",
    1,
    fixture.lane,
    capturedAt,
    total,
  ];
  const hash = (value: unknown) =>
    createHash("sha256").update(syncDeliveryBytes(value)).digest("hex");
  return {
    version: 1 as const,
    id: hash([
      ...identity,
      rows.map((row) =>
        syncDeliveryBytes(fixture.keys.map((key) => row[key])).toString("hex"),
      ),
    ]),
    sha256: hash([...identity, rows]),
  };
}
