// Native, atomic latest/history captures. No PostgreSQL dialect translation.
import type {
  FamilyPlan,
  FamilyMirrorInput,
} from "./hyperparams-identity-neon-write.ts";
import type { ProducerStore, ProducerStatement } from "./producer-store.ts";
import type { NeonWriteResult } from "./neon-write.ts";

function cell(value: unknown): string | number | null {
  if (value == null) return null;
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new TypeError(
    "Capture values must be finite scalars or serialized JSON",
  );
}

function upserts(
  plan: FamilyPlan["latest"],
  rows: Record<string, unknown>[],
  guard?: string,
): ProducerStatement[] {
  const { table, columns, conflict } = plan;
  const updates = columns.filter((column) => !conflict.includes(column));
  const text = `INSERT INTO ${table}(${columns.join(",")}) SELECT ${columns.map((_, i) => `json_extract(value,'$[${i}]')`).join(",")} FROM json_each(?) WHERE true
    ON CONFLICT(${conflict.join(",")}) DO UPDATE SET ${updates.map((column) => `${column}=excluded.${column}`).join(",")}${guard ? ` WHERE ${guard}` : ""}`;
  const statements: ProducerStatement[] = [];
  let batch: string[] = [],
    bytes = 2;
  const flush = () => {
    statements.push({ text, values: [`[${batch.join(",")}]`] });
    batch = [];
    bytes = 2;
  };
  for (const row of rows) {
    const encoded = JSON.stringify(columns.map((column) => cell(row[column])));
    const length = new TextEncoder().encode(encoded).byteLength + 1;
    if (length + 2 > 512 * 1024)
      throw new RangeError("Capture row exceeds 512 KiB");
    if (batch.length === 100 || bytes + length > 512 * 1024) flush();
    batch.push(encoded);
    bytes += length;
  }
  // Called only for a nonempty capture; every loop iteration appends a row.
  flush();
  return statements;
}

export async function writeCaptureFamilyD1(
  store: ProducerStore,
  plan: FamilyPlan,
  input: FamilyMirrorInput,
): Promise<Record<string, NeonWriteResult>> {
  const groups = [
    {
      name: plan.latest.table,
      rows: input.rows,
      plan: plan.latest,
      guard: `${plan.latest.table}.captured_at < EXCLUDED.captured_at`,
    },
    {
      name: plan.history.table,
      rows: input.historyRows,
      plan: plan.history,
      guard: plan.history.guard,
    },
  ];
  const results: Record<string, NeonWriteResult> = {};
  try {
    const statements: ProducerStatement[] = [];
    for (const group of groups) {
      if (!group.rows.length) continue;
      const prepared = upserts(group.plan, group.rows, group.guard);
      statements.push(...prepared);
      results[group.name] = {
        ok: true,
        rows: group.rows.length,
        statements: prepared.length,
      };
    }
    if (plan.prune && input.pruneKeys) {
      const name = `${plan.latest.table}:prune`;
      results[name] = {
        ok: true,
        rows: input.pruneKeys.length ? 1 : 0,
        statements: input.pruneKeys.length ? 1 : 0,
      };
      if (input.pruneKeys.length) {
        if (
          !input.pruneKeys.every((key) => Number.isSafeInteger(key) && key >= 0)
        )
          throw new TypeError("Invalid complete capture key set");
        statements.push({
          text: `DELETE FROM ${plan.latest.table} WHERE ${plan.prune.keyColumn} NOT IN (SELECT value FROM json_each(?))`,
          values: [JSON.stringify(input.pruneKeys)],
        });
      }
    }
    if (statements.length > 900)
      throw new RangeError("Capture exceeds atomic statement budget");
    await store.transaction(statements);
    return results;
  } catch (error) {
    const reason = String(error);
    // Every requested member reports failure; no partial capture was committed.
    for (const group of groups)
      if (group.rows.length)
        results[group.name] = { ok: false, rows: 0, statements: 0, reason };
    if (plan.prune && input.pruneKeys)
      results[`${plan.latest.table}:prune`] = {
        ok: false,
        rows: 0,
        statements: 0,
        reason,
      };
    return results;
  }
}
