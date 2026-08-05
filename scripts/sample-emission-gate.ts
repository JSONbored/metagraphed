// Sampler for the emission-gate change history (#8748) and the dormant
// TAO-flow path watch (#8750) -- the chain-reading half of the lane.
//
// Reads the gate parameters, the per-subnet enablement map, and the flow
// EMAs from the chain, then POSTs the readings to the main Worker's
// /api/v1/internal/emission-gate-sync route, which owns the rest: it loads
// the last known state per key from D1, runs the PURE decision functions in
// src/emission-gate-history.ts and src/emission-flow-monitor.ts, and
// batch-inserts only the rows those return. All of the "what counts as a
// change" judgement lives in those two modules, unit-tested without a chain
// or a database; this file is the chain-I/O shell and deliberately holds
// none of it.
//
// FORMERLY BOX-SIDE (a 10-minute systemd timer with a low-latency RPC path
// to our own nodes, writing straight into the box's Postgres). That box and
// its Postgres are decommissioned, and the lane now runs Worker-native as
// EMISSION_GATE_SAMPLE_CRON (workers/config.ts), reading the public archive
// endpoint on the same cadence. The GitHub Actions schedule that carried it
// in between was retired with the workflow -- an Actions hop bought nothing
// once the estate was Cloudflare-only, since the D1 tables it feeds are a
// binding the Worker already holds.
//
// This script survives as the box-side/manual entrypoint (invoked by
// scripts/data-refresh-node-entrypoint.sh's STEP=emission-gate-sample), not
// as the primary driver.
//
// Idempotent by construction: the differs return [] when nothing moved, so a
// run against an unchanged chain writes nothing at all. Re-running is safe.

import {
  sampleEmissionGate,
  type EmissionGateSample,
} from "../src/emission-gate-sampler.ts";

function requiredRpcUrl(): string {
  const url = process.env.EMISSION_SAMPLER_RPC_URL;
  if (url) return url;
  console.error(
    "EMISSION_SAMPLER_RPC_URL is required: the RPC endpoint of a node AT CHAIN TIP.",
  );
  process.exit(1);
}

function requiredSyncSecret(): string {
  const secret = process.env.EMISSION_GATE_SYNC_SECRET;
  if (secret) return secret;
  console.error(
    "EMISSION_GATE_SYNC_SECRET is required: the shared secret for POST /api/v1/internal/emission-gate-sync.",
  );
  process.exit(1);
}

const RPC_URL = requiredRpcUrl();
const SYNC_TOKEN = requiredSyncSecret();
const SYNC_URL = `${process.env.EMISSION_GATE_SYNC_URL ?? "https://api.metagraph.sh"}/api/v1/internal/emission-gate-sync`;
const RPC_TIMEOUT_MS = Number(
  process.env.EMISSION_SAMPLER_RPC_TIMEOUT_MS ?? 15_000,
);

interface EmissionGateSyncSummary {
  block_number: number;
  gate_param_rows: number;
  subnet_enabled_rows: number;
  flow_watch_rows: number;
  flow_alertable: number;
  subnets_seen: number;
  ema_entries_seen: number;
  alertable: { item: string; netuid: number | null }[];
}

async function main(): Promise<void> {
  // The chain-read + assembly now lives in src/emission-gate-sampler.ts so
  // the Worker cron runs the identical logic; this shell owns only the env
  // handling, the POST, the stdout contract, and the optional webhook alarm.
  const sample: EmissionGateSample = await sampleEmissionGate({
    rpcUrl: RPC_URL,
    timeoutMs: RPC_TIMEOUT_MS,
  });

  const resp = await fetch(SYNC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-emission-gate-sync-token": SYNC_TOKEN,
    },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify(sample),
  });
  if (!resp.ok) {
    const detail = (await resp.text()).slice(0, 300);
    throw new Error(`emission-gate-sync: HTTP ${resp.status} ${detail}`);
  }
  const summary = (await resp.json()) as EmissionGateSyncSummary;

  // Same stdout contract as the box run: one JSON line of counts.
  console.log(
    JSON.stringify({
      block_number: summary.block_number,
      gate_param_rows: summary.gate_param_rows,
      subnet_enabled_rows: summary.subnet_enabled_rows,
      flow_watch_rows: summary.flow_watch_rows,
      flow_alertable: summary.flow_alertable,
      subnets_seen: summary.subnets_seen,
      ema_entries_seen: summary.ema_entries_seen,
    }),
  );

  const alertable = summary.alertable ?? [];
  if (alertable.length > 0) {
    const what = alertable
      .map((e) => `${e.item}${e.netuid === null ? "" : `#${e.netuid}`}`)
      .join(", ");
    console.error(`ALERT: dormant TAO-flow path stirred — ${what}`);
    const webhook = process.env.LIVE_ALERT_WEBHOOK_URL;
    if (webhook) {
      try {
        await fetch(webhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(15_000),
          body: JSON.stringify({
            content:
              `🚨 metagraphed: the dormant TAO-flow emission path stirred at block ` +
              `${sample.block_number} — ${what}. v440's get_shares_flow may be going live; ` +
              `every published emission number moves if it does (#8750).`,
          }),
        });
      } catch (err) {
        console.error(
          `alert webhook failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }
}

main().catch((err) => {
  console.error(
    `sample-emission-gate failed: ${err instanceof Error ? err.message : err}`,
  );
  process.exitCode = 1;
});
