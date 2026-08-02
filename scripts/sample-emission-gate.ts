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
// its Postgres are decommissioned, so the lane is restored as a GitHub
// Actions schedule (.github/workflows/sample-emission-gate.yml) on the same
// cadence, reading the public archive endpoint -- and the persistence moved
// behind the Worker route because a stateless Actions runner has no database
// of its own and D1 is not internet-addressable except through the Worker.
//
// Idempotent by construction: the differs return [] when nothing moved, so a
// run against an unchanged chain writes nothing at all. Re-running is safe.

import {
  EMISSION_BAR_QUANTILE_STORAGE_KEY,
  EMISSION_GATE_BAR_STORAGE_KEY,
  EMISSION_GATE_EXPONENT_STORAGE_KEY,
  TOTAL_ISSUANCE_STORAGE_KEY,
  decodeLeU128,
  decodeLeU64,
  u64f64U128ToFloat,
} from "../src/network-parameters.ts";
import {
  FLOW_PARAM_ITEMS,
  decodeSubnetEmaTaoFlow,
  type FlowParamItem,
  type FlowParamObservation,
} from "../src/emission-flow-monitor.ts";
import type { GateParamReading } from "../src/emission-gate-history.ts";
import { blockEmissionForIssuance } from "../src/block-emission.ts";

// Required, with no committed default. scan:public-safety bans private and
// loopback URLs anywhere in the repo, and a baked-in 127.0.0.1 would be wrong
// for every host but one anyway. Failing closed here makes a direct
// invocation say what is missing instead of quietly dialling localhost.
function requiredRpcUrl(): string {
  const url = process.env.EMISSION_SAMPLER_RPC_URL;
  if (url) return url;
  console.error(
    "EMISSION_SAMPLER_RPC_URL is required: the RPC endpoint of a node AT CHAIN TIP.",
  );
  process.exit(1);
}

// Same fail-closed posture as requiredRpcUrl: the sync route 401s without it,
// so a run with no secret can only fail -- say so up front, clearly.
function requiredSyncSecret(): string {
  const secret = process.env.EMISSION_GATE_SYNC_SECRET;
  if (secret) return secret;
  console.error(
    "EMISSION_GATE_SYNC_SECRET is required: the shared secret for POST /api/v1/internal/emission-gate-sync.",
  );
  process.exit(1);
}

const RPC_URL = requiredRpcUrl();
// Named for the header it travels in (x-emission-gate-sync-token) -- and a
// `SECRET =`-shaped assignment would trip scan:public-safety's token-like
// pattern on the function call's own name.
const SYNC_TOKEN = requiredSyncSecret();
// Overridable for staging/local Worker runs; the committed default is the
// public production API, same convention as the other Actions-run sync
// scripts.
const SYNC_URL = `${process.env.EMISSION_GATE_SYNC_URL ?? "https://api.metagraph.sh"}/api/v1/internal/emission-gate-sync`;
const RPC_TIMEOUT_MS = Number(
  process.env.EMISSION_SAMPLER_RPC_TIMEOUT_MS ?? 15_000,
);

// twox128("SubtensorModule") ++ twox128("SubnetEmissionEnabled"). A bool map;
// ABSENT MEANS ENABLED (the runtime default is true), so the decoded value is
// what matters, never key presence -- see subnetEnabledChanges' own comment.
const SUBNET_EMISSION_ENABLED_PREFIX =
  "0x658faa385070e074c85bf6b568cf0555c97bb5c5631e5f593b5bd2da84a5fa16";
// twox128("SubtensorModule") ++ twox128("SubnetEmaTaoFlow").
const SUBNET_EMA_TAO_FLOW_PREFIX =
  "0x658faa385070e074c85bf6b568cf05559f25bd6b257310b72a9310520b27a626";

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const resp = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!resp.ok) throw new Error(`${method}: HTTP ${resp.status}`);
  const body = (await resp.json()) as {
    result?: T;
    error?: { message?: string };
  };
  if (body.error)
    throw new Error(`${method}: ${body.error.message ?? "rpc error"}`);
  return body.result as T;
}

/** These maps key on `prefix ++ netuid as u16 little-endian`, Identity-hashed
 * (no hasher prefix), so the netuid is simply the last 4 hex chars. */
function netuidFromKey(key: string, prefix: string): number | null {
  if (!key.startsWith(prefix) || key.length !== prefix.length + 4) return null;
  const le = key.slice(-4);
  return parseInt(le.slice(2, 4) + le.slice(0, 2), 16);
}

/** state_getKeysPaged REQUIRES params[2] to be OMITTED, not null — passing
 * null makes the RPC proxy 400. Hence the conditional spread. */
async function keysPaged(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let startKey: string | undefined;
  for (;;) {
    const page = await rpc<string[]>("state_getKeysPaged", [
      prefix,
      500,
      ...(startKey ? [startKey] : []),
    ]);
    if (!page?.length) break;
    keys.push(...page);
    if (page.length < 500) break;
    startKey = page[page.length - 1];
  }
  return keys;
}

async function readU64F64(storageKey: string): Promise<number | null> {
  const raw = await rpc<string | null>("state_getStorage", [storageKey]);
  if (raw === null) return null;
  const bits = decodeLeU128(raw);
  return bits === null ? null : u64f64U128ToFloat(bits);
}

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
  const header = await rpc<{ number: string }>("chain_getHeader", []);
  const blockNumber = parseInt(header.number, 16);
  const observedAt = Date.now();

  // --- gate parameters -----------------------------------------------------
  const [bar, quantile, exponent, totalIssuanceRaw] = await Promise.all([
    readU64F64(EMISSION_GATE_BAR_STORAGE_KEY),
    readU64F64(EMISSION_BAR_QUANTILE_STORAGE_KEY),
    readU64F64(EMISSION_GATE_EXPONENT_STORAGE_KEY),
    rpc<string | null>("state_getStorage", [TOTAL_ISSUANCE_STORAGE_KEY]),
  ]);

  // Halvings, not the emission itself: the TAO-per-block figure drifts with
  // issuance, but the HALVING COUNT is a step function that moves a handful of
  // times in the network's life -- which is what belongs in a change log.
  //
  // TotalIssuance is a u64, NOT a u128 like the three gate parameters above --
  // decodeLeU128 REJECTS its 16-hex-char value and returns null, which silently
  // recorded the halving count as "unknown" on the first live run. Matches
  // src/network-parameters.ts, which reads this same key via fetchStorageU64.
  const issuanceBits = decodeLeU64(totalIssuanceRaw);
  const halvings = blockEmissionForIssuance(issuanceBits)?.halvings ?? null;

  const current: GateParamReading = {
    emission_gate_bar: bar,
    emission_bar_quantile: quantile,
    // Raw, NOT the effective value: `h` unset means the runtime default 3,
    // and collapsing the two here would record a governance change the moment
    // someone explicitly sets it TO 3. /api/v1/network/parameters serves both
    // separately for the same reason.
    emission_gate_exponent: exponent,
    block_emission_halvings: halvings,
  };

  // --- per-subnet enablement ----------------------------------------------
  // ABSENT KEY MEANS ENABLED. Enumerating only the keys that exist would
  // therefore report every default-enabled subnet as missing rather than
  // enabled, so the decoded value of each present key is what is passed and
  // absent netuids are simply not claimed either way.
  const enabledKeys = await keysPaged(SUBNET_EMISSION_ENABLED_PREFIX);
  const currentEnabled = new Map<number, boolean>();
  for (const key of enabledKeys) {
    const netuid = netuidFromKey(key, SUBNET_EMISSION_ENABLED_PREFIX);
    if (netuid === null) continue;
    const raw = await rpc<string | null>("state_getStorage", [key]);
    // 0x00 is disabled; anything else present is enabled.
    currentEnabled.set(netuid, raw !== "0x00");
  }

  // --- dormant flow path (#8750) ------------------------------------------
  const flowObservations: FlowParamObservation[] = [];
  for (const [item, key] of Object.entries(FLOW_PARAM_ITEMS) as [
    FlowParamItem,
    string,
  ][]) {
    const raw = await rpc<string | null>("state_getStorage", [key]);
    flowObservations.push({ item, raw });
  }

  const emaKeys = await keysPaged(SUBNET_EMA_TAO_FLOW_PREFIX);
  const currentEma = new Map<number, { block: number } | null>();
  for (const key of emaKeys) {
    const netuid = netuidFromKey(key, SUBNET_EMA_TAO_FLOW_PREFIX);
    if (netuid === null) continue;
    const raw = await rpc<string | null>("state_getStorage", [key]);
    currentEma.set(netuid, decodeSubnetEmaTaoFlow(raw));
  }

  // --- hand the readings to the Worker route -------------------------------
  // Maps serialize as [key, value] pair arrays (JSON has no Map); the route
  // rebuilds them and runs the differs against D1's last-known state.
  const resp = await fetch(SYNC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-emission-gate-sync-token": SYNC_TOKEN,
    },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      block_number: blockNumber,
      observed_at: observedAt,
      current,
      current_enabled: [...currentEnabled],
      flow_observations: flowObservations,
      current_ema: [...currentEma],
    }),
  });
  if (!resp.ok) {
    const detail = (await resp.text()).slice(0, 300);
    throw new Error(`emission-gate-sync: HTTP ${resp.status} ${detail}`);
  }
  const summary = (await resp.json()) as EmissionGateSyncSummary;

  // Same stdout contract as the box run, so the workflow log reads the same:
  // one JSON line of counts. (The route also echoes `ok`/`alertable`; the
  // counts line stays counts-only.)
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

  // Alertable events are the ones that are NOT a first observation -- the
  // route computes and returns them so this alarm behaves exactly as it did
  // box-side.
  const alertable = summary.alertable ?? [];
  if (alertable.length > 0) {
    const what = alertable
      .map((e) => `${e.item}${e.netuid === null ? "" : `#${e.netuid}`}`)
      .join(", ");
    console.error(`ALERT: dormant TAO-flow path stirred — ${what}`);
    // Same optional-webhook convention as the testnet-discovery step and
    // indexer-rs's own alert_stuck_block: quietly no-ops when unset rather
    // than failing the run, and a failed POST must never lose the rows that
    // were already written.
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
              `${blockNumber} — ${what}. v440's get_shares_flow may be going live; ` +
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
