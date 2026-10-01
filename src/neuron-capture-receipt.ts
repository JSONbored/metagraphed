import { createHash } from "node:crypto";
import { isD1ConnectionError } from "./d1-connection-error.ts";
import { NEURON_INSERT_COLUMNS } from "./metagraph-neurons.ts";
import type { PassTallyInput } from "./pass-completeness.ts";
import type { ProducerStatement, ProducerStore } from "./producer-store.ts";

/** A producer can resend a committed chunk after losing its reply. Its stable
 * membership identifies the chunk; its original metrics pin its contents.
 * Derived updated_at values are deliberately outside that identity. */
export function neuronPassWrite(
  pass: PassTallyInput,
  rows: readonly Record<string, unknown>[],
) {
  const ordered = [...rows].sort(
    (a, b) =>
      Number(a.netuid) - Number(b.netuid) || Number(a.uid) - Number(b.uid),
  );
  const hash = (value: unknown) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const batchId = hash([
    pass.capturedAt,
    pass.receivedRows,
    ordered.map((row) => [row.netuid, row.uid]),
  ]);
  const digest = hash([
    pass.expectedRows,
    ordered.map((row) =>
      NEURON_INSERT_COLUMNS.map((column) =>
        typeof row[column] === "boolean"
          ? Number(row[column])
          : (row[column] ?? null),
      ),
    ),
  ]);
  const statements: ProducerStatement[] = [
    {
      // Preserve incomplete-pass receipts. Completed historical pass rows
      // prevent any late resend from recounting a pruned receipt.
      text: `DELETE FROM neurons_capture_batches WHERE batch_id IN (
        SELECT r.batch_id FROM neurons_capture_batches r
        JOIN neurons_passes p ON p.captured_at=r.captured_at
        WHERE p.completed_at IS NOT NULL AND r.captured_at<?
        ORDER BY r.captured_at,r.batch_id LIMIT 200)`,
      values: [pass.nowMs - 600_000],
    },
    {
      text: `INSERT INTO neurons_capture_batches(batch_id,captured_at,sha256)
        SELECT ?,?,? WHERE NOT EXISTS (
          SELECT 1 FROM neurons_passes WHERE captured_at=? AND completed_at IS NOT NULL)
        ON CONFLICT(batch_id) DO UPDATE SET sha256=CASE
          WHEN neurons_capture_batches.sha256=excluded.sha256 THEN excluded.sha256 ELSE NULL END`,
      values: [batchId, pass.capturedAt, digest, pass.capturedAt],
    },
    {
      text: `INSERT INTO neurons_passes(captured_at,expected_rows,received_rows,completed_at)
        SELECT ?,?,?,CASE WHEN ? >= ? THEN ? ELSE NULL END
        FROM neurons_capture_batches WHERE batch_id=? AND sha256=? AND applied=0
        ON CONFLICT(captured_at) DO UPDATE SET expected_rows=excluded.expected_rows,
          received_rows=neurons_passes.received_rows+excluded.received_rows,
          completed_at=COALESCE(neurons_passes.completed_at,CASE
            WHEN neurons_passes.received_rows+excluded.received_rows >= excluded.expected_rows THEN ? ELSE NULL END)`,
      values: [
        pass.capturedAt,
        pass.expectedRows,
        pass.receivedRows,
        pass.receivedRows,
        pass.expectedRows,
        pass.nowMs,
        batchId,
        digest,
        pass.nowMs,
      ],
    },
    {
      text: "UPDATE neurons_capture_batches SET applied=1 WHERE batch_id=? AND sha256=?",
      values: [batchId, digest],
    },
  ];
  return {
    statements,
    async acknowledge(store: ProducerStore) {
      const receipt = await store.first<{ sha256: string; applied: number }>(
        "SELECT sha256,applied FROM neurons_capture_batches WHERE batch_id=?",
        [batchId],
      );
      if (receipt?.sha256 === digest && receipt.applied === 1) return;
      if (!receipt) {
        const complete = await store.first<{
          expected_rows: number;
          received_rows: number;
          completed_at: number | null;
        }>(
          "SELECT expected_rows,received_rows,completed_at FROM neurons_passes WHERE captured_at=?",
          [pass.capturedAt],
        );
        if (
          complete &&
          complete.received_rows >= complete.expected_rows &&
          complete.completed_at !== null &&
          complete.completed_at >= pass.capturedAt
        )
          return;
      }
      throw new Error("Neuron capture batch was not acknowledged");
    },
  };
}

/** Retry only the idempotent document write and its atomic pass receipt. */
export async function retryNeuronCapture(
  apply: () => Promise<void>,
): Promise<void> {
  try {
    await apply();
  } catch (error) {
    if (!isD1ConnectionError(error)) throw error;
    await new Promise((resolve) =>
      setTimeout(resolve, 250 + Math.floor(Math.random() * 250)),
    );
    await apply();
  }
}
