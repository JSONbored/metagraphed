// Native ledger transactions: data, pruning, delivery receipts and pass tally
// commit together. No buffered PostgreSQL statements enter this path.
import { captureUpsertStatements } from "./capture-family-d1.ts";
import { PASS_TABLES, type PassTallyInput } from "./pass-completeness.ts";
import { LEDGER_MIRROR_PLANS } from "./ledger-neon-write.ts";
import {
  POSITION_INSERT_COLUMNS_WITH_SOURCE,
  NOMINATOR_POSITIONS_CONFLICT,
  POSITION_SOURCE_ALPHA,
  NOMINATOR_POSITIONS_NEON_LANE,
  type NominatorPositionsInput,
  type NominatorPositionsMirrorOutcome,
} from "./nominator-positions-neon-write.ts";
import { NOMINATOR_SCAN_RECEIPTS_RETENTION_MS } from "./nominator-scan-receipts.ts";
import type { ProducerStore, ProducerStatement } from "./producer-store.ts";
import type { NeonWriteResult } from "./neon-write.ts";

function passStatement(lane: string, pass: PassTallyInput): ProducerStatement {
  const table = PASS_TABLES[lane];
  return {
    text: `INSERT INTO ${table}(captured_at,expected_rows,received_rows,completed_at)
      VALUES (?,?,?,CASE WHEN ? >= ? THEN ? ELSE NULL END)
      ON CONFLICT(captured_at) DO UPDATE SET expected_rows=excluded.expected_rows,
      received_rows=${table}.received_rows+excluded.received_rows,
      completed_at=COALESCE(${table}.completed_at,CASE WHEN ${table}.received_rows+excluded.received_rows >= excluded.expected_rows THEN ? ELSE NULL END)`,
    values: [
      pass.capturedAt,
      pass.expectedRows,
      pass.receivedRows,
      pass.receivedRows,
      pass.expectedRows,
      pass.nowMs,
      pass.nowMs,
    ],
  };
}

async function commit(
  store: ProducerStore,
  statements: ProducerStatement[],
): Promise<void> {
  if (statements.length > 900)
    throw new RangeError("Ledger exceeds atomic statement budget");
  await store.transaction(statements);
}

export async function writeLedgerD1(
  store: ProducerStore,
  lane: string,
  rows: Record<string, unknown>[],
  pass?: PassTallyInput | null,
): Promise<NeonWriteResult> {
  try {
    const plan = LEDGER_MIRROR_PLANS[lane];
    const statements = rows.length
      ? captureUpsertStatements(
          plan,
          rows,
          `${plan.table}.captured_at < excluded.captured_at`,
          lane === "hotkey-alpha"
            ? "EXISTS (SELECT 1 FROM nominator_positions np WHERE np.hotkey=json_extract(value,'$[0]') AND np.netuid=json_extract(value,'$[1]'))"
            : "true",
        )
      : [];
    if (pass) statements.push(passStatement(lane, pass));
    await commit(store, statements);
    return { ok: true, rows: rows.length, statements: statements.length };
  } catch (error) {
    return { ok: false, rows: 0, statements: 0, reason: String(error) };
  }
}

export async function writeNominatorPositionsD1(
  store: ProducerStore,
  input: NominatorPositionsInput,
): Promise<NominatorPositionsMirrorOutcome> {
  const source = input.source ?? POSITION_SOURCE_ALPHA;
  const parts: Record<string, NeonWriteResult> = {};
  try {
    const rows: Record<string, unknown>[] = input.rows.map((row) => ({
      ...row,
      source,
    }));
    const statements = rows.length
      ? captureUpsertStatements(
          {
            table: "nominator_positions",
            columns: POSITION_INSERT_COLUMNS_WITH_SOURCE,
            conflict: NOMINATOR_POSITIONS_CONFLICT,
          },
          rows,
          "nominator_positions.captured_at < excluded.captured_at",
        )
      : [];
    parts.write = {
      ok: true,
      rows: rows.length,
      statements: statements.length,
    };
    const cutoffs = [...input.coldkeyMaxCapturedAt];
    parts.prune = {
      ok: true,
      rows: cutoffs.length,
      statements: cutoffs.length ? 1 : 0,
    };
    if (cutoffs.length)
      statements.push({
        text: `DELETE FROM nominator_positions WHERE (coldkey,hotkey,netuid) IN
        (SELECT p.coldkey,p.hotkey,p.netuid FROM json_each(?) cutoff
        JOIN nominator_positions p ON p.coldkey=json_extract(cutoff.value,'$[0]')
        WHERE p.source=? AND p.captured_at < json_extract(cutoff.value,'$[1]'))`,
        values: [JSON.stringify(cutoffs), source],
      });
    if (source === POSITION_SOURCE_ALPHA) {
      const receipts = new Map<
        string,
        { captured_at: number; coldkey: string; row_count: number }
      >();
      let oldest = Infinity;
      for (const row of rows) {
        const captured_at = Number(row.captured_at),
          coldkey = String(row.coldkey);
        oldest = Math.min(oldest, captured_at);
        const key = JSON.stringify([captured_at, coldkey]);
        const previous = receipts.get(key);
        if (previous) previous.row_count++;
        else receipts.set(key, { captured_at, coldkey, row_count: 1 });
      }
      const prepared = receipts.size
        ? captureUpsertStatements(
            {
              table: "nominator_scan_receipts",
              columns: ["captured_at", "coldkey", "row_count"],
              conflict: ["captured_at", "coldkey"],
            },
            [...receipts.values()],
          )
        : [];
      parts.coverage = {
        ok: true,
        rows: receipts.size,
        statements: prepared.length,
      };
      if (receipts.size)
        statements.push(
          {
            text: "DELETE FROM nominator_scan_receipts WHERE captured_at < ?",
            values: [oldest - NOMINATOR_SCAN_RECEIPTS_RETENTION_MS],
          },
          ...prepared,
        );
    }
    if (input.pass) {
      // Only pools affected by this chunk need recalculation. Their earlier
      // chunks participate in the denominator. Raw shares remain decimal TEXT;
      // only the served, double-precision fraction is evaluated as REAL.
      statements.push(
        {
          text: `WITH pools AS (SELECT DISTINCT json_extract(value,'$.hotkey') AS hotkey,json_extract(value,'$.netuid') AS netuid FROM json_each(?)),
          totals AS (SELECT p.hotkey,p.netuid,SUM(CAST(p.shares AS REAL)) AS total
          FROM nominator_positions p JOIN pools USING(hotkey,netuid)
          WHERE captured_at=? AND shares IS NOT NULL GROUP BY p.hotkey,p.netuid)
          UPDATE nominator_positions AS p SET share_fraction=CAST(p.shares AS REAL)/t.total
          FROM totals t WHERE p.hotkey=t.hotkey AND p.netuid=t.netuid AND p.captured_at=?
          AND p.shares IS NOT NULL AND t.total>0
          AND p.share_fraction IS NOT CAST(p.shares AS REAL)/t.total`,
          values: [
            JSON.stringify(
              rows.map(({ hotkey, netuid }) => ({ hotkey, netuid })),
            ),
            input.pass.capturedAt,
            input.pass.capturedAt,
          ],
        },
        passStatement(NOMINATOR_POSITIONS_NEON_LANE, input.pass),
      );
      parts.pass = { ok: true, rows: 1, statements: 1 };
    }
    await commit(store, statements);
    return { attempted: true, ...parts };
  } catch (error) {
    const failure = {
      ok: false,
      rows: 0,
      statements: 0,
      reason: String(error),
    };
    return {
      attempted: true,
      write: failure,
      prune: failure,
      ...(source === POSITION_SOURCE_ALPHA ? { coverage: failure } : {}),
      ...(input.pass ? { pass: failure } : {}),
    };
  }
}
