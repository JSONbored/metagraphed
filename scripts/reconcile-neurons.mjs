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
// Usage: node scripts/reconcile-neurons.mjs
import postgres from "postgres";
import { readFile } from "node:fs/promises";
import { stableStringify } from "./lib.mjs";
import { initSentry } from "./observability.mjs";

initSentry("reconcile-neurons");

// Below this absolute TAO delta, a mismatch is never flagged regardless of
// relative size -- avoids false positives on near-zero stakes where a tiny
// absolute change looks like a huge percentage. Above it, tolerate up to 2%
// relative drift before flagging a single row: ordinary staking/unstaking
// activity between refresh-metagraph's last write and this reconciler's own
// fetch produces real, benign per-row differences at this scale.
const ABSOLUTE_FLOOR_TAO = 0.01;
const RELATIVE_TOLERANCE = 0.02;
// RATIO, not a fixed count: refresh-metagraph runs DAILY (not hourly --
// corrected after live testing against the real box, 2026-07-15), so
// Postgres can legitimately be up to ~24h stale depending on where in the
// cycle this job runs relative to it. A fixed small count would alert on
// every single run purely from that lag (confirmed live: 15% of all rows
// individually exceeded per-row tolerance after ~7h of staleness, entirely
// explained by ordinary network-wide staking activity, not a bug). A ratio
// scales with however stale Postgres happens to be and stays meaningful
// regardless of network size. 30% is deliberately conservative pending real
// drift history to tune against -- scheduled to run shortly after
// refresh-metagraph's own daily fire (roles/data-refresh-node's job vars)
// specifically to keep legitimate lag-driven drift low, so a genuine
// systemic break (stalled sync, decode bug) should clear this threshold by
// a wide margin rather than needing to be tuned razor-close to it.
const ALERT_THRESHOLD_RATIO = 0.3;
const MAX_EXAMPLES_IN_ALERT = 10;

function fieldsDiffer(liveValue, storedValue) {
  const live = Number(liveValue);
  const stored = storedValue === null ? null : Number(storedValue);
  if (!Number.isFinite(live)) return false; // fetch didn't produce a value for this field -- not this reconciler's problem
  if (stored === null || !Number.isFinite(stored)) return true; // Postgres has no comparable value at all
  const delta = Math.abs(live - stored);
  if (delta <= ABSOLUTE_FLOOR_TAO) return false;
  const tolerance = Math.max(
    ABSOLUTE_FLOOR_TAO,
    RELATIVE_TOLERANCE * Math.abs(live),
  );
  return delta > tolerance;
}

async function main() {
  const snapshotPath = process.env.LIVE_SNAPSHOT_JSON;
  if (!snapshotPath) throw new Error("LIVE_SNAPSHOT_JSON env var required");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL env var required");

  const liveRows = JSON.parse(await readFile(snapshotPath, "utf8"));
  if (!Array.isArray(liveRows) || !liveRows.length) {
    throw new Error(
      `LIVE_SNAPSHOT_JSON (${snapshotPath}) is empty or not an array`,
    );
  }

  const sql = postgres(databaseUrl, { max: 1 });
  let storedRows;
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

  const mismatches = [];
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
    const fields = [];
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
  const summary = {
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

  if (mismatchRatio >= ALERT_THRESHOLD_RATIO) {
    await sendAlert(summary, mismatches.slice(0, MAX_EXAMPLES_IN_ALERT));
  }
}

async function sendAlert(summary, examples) {
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
        : `netuid ${m.netuid} uid ${m.uid}: ${m.fields.join(",")} live=${m.live_stake_tao} stored=${m.stored_stake_tao}`,
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

await main();
