// Drift-detection reconciler (#5776, successor to #2115's "reconciler" half
// -- see #2538 for the sibling "exporter" half, which this deliberately
// does NOT share a job with: exporting is a bulk dump, reconciling needs a
// FRESH chain read to compare against, a different trust/cost shape).
//
// Compares Postgres's `neurons` table (folded/aggregated state, written by
// the existing refresh-metagraph box job) against a fresh, independently-
// fetched live chain snapshot, and alerts on drift beyond tolerance. Does
// NOT auto-correct anything -- alert-only, so a human decides whether a
// flagged row is a real bug or expected sync lag.
//
// Scope: stake_tao + emission_tao on `neurons` only. #5776's issue text
// also mentions "balances" and "yield" -- balances aren't part of this
// dataset at all (a separate Balances-pallet read, out of scope for v1),
// and "yield" has no direct on-chain storage to reconcile against (it's a
// derived/computed metric from stake changes over time, not a value this
// kind of point-in-time diff can meaningfully verify). stake_tao/
// emission_tao are the two fields this fetch already produces that have a
// genuine "folded value vs. runtime truth" comparison.
//
// Input: LIVE_SNAPSHOT_JSON, the exact output of
// scripts/fetch-metagraph-native.py (run as a separate, untrusted,
// no-secrets container -- see scripts/data-refresh-node-entrypoint.sh's
// reconcile-neurons STEP and the infra role's custom wrapper script for
// why this is two containers, not one: same fetch/authenticated-step trust
// split every other chain-reading box job already uses).
//
// Usage: node scripts/reconcile-neurons.ts
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { stableStringify } from "./lib.ts";
import { initSentry, endSessionAndFlush } from "./observability.ts";
import {
  ABSOLUTE_FLOOR_TAO,
  ALERT_THRESHOLD_RATIO,
  RELATIVE_TOLERANCE,
  exceedsAlertThreshold,
  fieldsDiffer,
} from "./lib/reconcile-neurons-tolerance.ts";

export {
  ABSOLUTE_FLOOR_TAO,
  ALERT_THRESHOLD_RATIO,
  RELATIVE_TOLERANCE,
  exceedsAlertThreshold,
  fieldsDiffer,
} from "./lib/reconcile-neurons-tolerance.ts";

type Row = Record<string, unknown>;

const MAX_EXAMPLES_IN_ALERT = 10;

interface Mismatch {
  netuid: unknown;
  uid: unknown;
  reason: "missing_in_postgres" | "value_drift";
  fields?: string[];
  live_stake_tao?: unknown;
  stored_stake_tao?: unknown;
}

interface Summary {
  compared: number;
  mismatches: number;
  mismatch_ratio: number;
  tolerance: {
    absolute_floor_tao: number;
    relative: number;
    alert_ratio: number;
  };
}

async function main(): Promise<void> {
  const snapshotPath = process.env.LIVE_SNAPSHOT_JSON;
  if (!snapshotPath) throw new Error("LIVE_SNAPSHOT_JSON env var required");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL env var required");

  const liveRows: Row[] = JSON.parse(await readFile(snapshotPath, "utf8"));
  if (!Array.isArray(liveRows) || !liveRows.length) {
    throw new Error(
      `LIVE_SNAPSHOT_JSON (${snapshotPath}) is empty or not an array`,
    );
  }

  const sql = postgres(databaseUrl, { max: 1 });
  let storedRows: Row[];
  try {
    storedRows = await sql`
      SELECT netuid, uid, stake_tao, emission_tao FROM neurons
    `;
  } finally {
    await sql.end();
  }

  const storedByKey = new Map(
    storedRows.map((row) => [`${row.netuid}:${row.uid}`, row]),
  );

  const mismatches: Mismatch[] = [];
  for (const live of liveRows) {
    const key = `${live.netuid}:${live.uid}`;
    const stored = storedByKey.get(key);
    if (!stored) {
      mismatches.push({
        netuid: live.netuid,
        uid: live.uid,
        reason: "missing_in_postgres",
      });
      continue;
    }
    const fields: string[] = [];
    if (fieldsDiffer(live.stake_tao, stored.stake_tao))
      fields.push("stake_tao");
    if (fieldsDiffer(live.emission_tao, stored.emission_tao))
      fields.push("emission_tao");
    if (fields.length) {
      mismatches.push({
        netuid: live.netuid,
        uid: live.uid,
        reason: "value_drift",
        fields,
        live_stake_tao: live.stake_tao,
        stored_stake_tao: stored.stake_tao,
      });
    }
  }

  const mismatchRatio = mismatches.length / liveRows.length;
  const summary: Summary = {
    compared: liveRows.length,
    mismatches: mismatches.length,
    mismatch_ratio: Number(mismatchRatio.toFixed(4)),
    tolerance: {
      absolute_floor_tao: ABSOLUTE_FLOOR_TAO,
      relative: RELATIVE_TOLERANCE,
      alert_ratio: ALERT_THRESHOLD_RATIO,
    },
  };
  console.log(stableStringify(summary));

  if (exceedsAlertThreshold(mismatchRatio)) {
    await sendAlert(summary, mismatches.slice(0, MAX_EXAMPLES_IN_ALERT));
  }
}

async function sendAlert(
  summary: Summary,
  examples: Mismatch[],
): Promise<void> {
  const webhookUrl = process.env.LIVE_ALERT_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log(
      "no LIVE_ALERT_WEBHOOK_URL configured -- skipping alert, drift logged above",
    );
    return;
  }
  const exampleLines = examples
    .map((m) =>
      m.reason === "missing_in_postgres"
        ? `netuid ${m.netuid} uid ${m.uid}: missing in Postgres`
        : `netuid ${m.netuid} uid ${m.uid}: ${(m.fields || []).join(",")} live=${m.live_stake_tao} stored=${m.stored_stake_tao}`,
    )
    .join("\n");
  const pct = (summary.mismatch_ratio * 100).toFixed(1);
  const content = `🟠 metagraphed reconciler: ${summary.mismatches}/${summary.compared} (${pct}%) neurons rows drifted beyond tolerance\n\`\`\`\n${exampleLines}\n\`\`\``;
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!response.ok) {
    console.error(`reconciler alert webhook failed (${response.status})`);
  }
}

// Run as a CLI only when invoked directly (not when imported by a test).
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  initSentry("reconcile-neurons");
  await main();
  await endSessionAndFlush();
}
