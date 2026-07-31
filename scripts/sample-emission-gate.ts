// Box-side sampler for the emission-gate change history (#8748) and the
// dormant TAO-flow path watch (#8750).
//
// Reads the gate parameters, the per-subnet enablement map, and the flow
// EMAs from the chain, hands them to the PURE decision functions in
// src/emission-gate-history.ts and src/emission-flow-monitor.ts, and INSERTs
// only the rows those return. All of the "what counts as a change" judgement
// lives in those two modules, unit-tested without a chain or a database; this
// file is the I/O shell around them and deliberately holds none of it.
//
// WHY BOX-SIDE rather than a Worker cron: theta is recomputed by the runtime
// every 360 blocks (~72 minutes), and catching its moves needs a cadence
// tighter than the edge's scheduled triggers are meant for -- while this box
// already has a low-latency RPC path to our own nodes. Modelled on the
// data-refresh-node role (deploy/data-refresh-node.Dockerfile +
// scripts/data-refresh-node-entrypoint.sh), same as every other box-side job.
//
// Idempotent by construction: the differs return [] when nothing moved, so a
// run against an unchanged chain writes nothing at all. Re-running is safe.

import {
  gateParamChanges,
  subnetEnabledChanges,
  type GateParam,
  type GateParamReading,
} from "../src/emission-gate-history.ts";
import {
  EMA_FROZEN_BASELINE_BLOCK,
  FLOW_PARAM_ITEMS,
  decodeSubnetEmaTaoFlow,
  emaAdvancedEvents,
  flowParamEvents,
  type FlowParamItem,
  type FlowParamObservation,
} from "../src/emission-flow-monitor.ts";
import {
  EMISSION_BAR_QUANTILE_STORAGE_KEY,
  EMISSION_GATE_BAR_STORAGE_KEY,
  EMISSION_GATE_EXPONENT_STORAGE_KEY,
  TOTAL_ISSUANCE_STORAGE_KEY,
  decodeLeU128,
  decodeLeU64,
  u64f64U128ToFloat,
} from "../src/network-parameters.ts";
import { blockEmissionForIssuance } from "../src/block-emission.ts";

const RPC_URL = process.env.EMISSION_SAMPLER_RPC_URL ?? "http://127.0.0.1:9944";
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

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL required");

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

  // Lazy dynamic import + the `postgres` client, matching
  // scripts/apply-migrations.ts: importing this module for a unit test must
  // never open a database connection.
  const { default: postgres } = await import("postgres");
  const sql = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    fetch_types: false,
  });

  try {
    // Latest known value per parameter. DISTINCT ON is the cheap read against
    // the (param, observed_at DESC) index the migration creates.
    const prevParams = await sql<{ param: string; value: string | null }[]>`
      SELECT DISTINCT ON (param) param, value
        FROM emission_gate_param_history
       ORDER BY param, observed_at DESC`;
    const previous: GateParamReading = {};
    for (const row of prevParams) {
      previous[row.param as GateParam] =
        row.value === null ? null : Number(row.value);
    }

    const paramChanges = gateParamChanges({
      current,
      previous,
      blockNumber,
      observedAt,
    });
    for (const c of paramChanges) {
      await sql`
        INSERT INTO emission_gate_param_history
          (param, value, previous_value, source, block_number, observed_at, predates_capture)
        VALUES (${c.param}, ${c.value}, ${c.previous_value}, ${c.source},
                ${c.block_number}, ${c.observed_at}, ${c.predates_capture})`;
    }

    // --- per-subnet enablement --------------------------------------------
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

    const prevEnabled = await sql<{ netuid: number; enabled: boolean }[]>`
      SELECT DISTINCT ON (netuid) netuid, enabled
        FROM subnet_emission_enabled_history
       ORDER BY netuid, observed_at DESC`;
    const previousEnabled = new Map<number, boolean>(
      prevEnabled.map((r) => [r.netuid, r.enabled]),
    );

    const enabledChanges = subnetEnabledChanges({
      current: currentEnabled,
      previous: previousEnabled,
      blockNumber,
      observedAt,
    });
    for (const c of enabledChanges) {
      await sql`
        INSERT INTO subnet_emission_enabled_history
          (netuid, enabled, previous_enabled, block_number, observed_at, predates_capture)
        VALUES (${c.netuid}, ${c.enabled}, ${c.previous_enabled},
                ${c.block_number}, ${c.observed_at}, ${c.predates_capture})`;
    }

    // --- dormant flow path (#8750) ----------------------------------------
    const flowObservations: FlowParamObservation[] = [];
    for (const [item, key] of Object.entries(FLOW_PARAM_ITEMS) as [
      FlowParamItem,
      string,
    ][]) {
      const raw = await rpc<string | null>("state_getStorage", [key]);
      flowObservations.push({ item, raw });
    }

    const prevFlow = await sql<{ item: string; is_set: boolean }[]>`
      SELECT DISTINCT ON (item) item, is_set
        FROM emission_flow_watch
       WHERE item <> 'subnet_ema_tao_flow'
       ORDER BY item, observed_at DESC`;
    const previousFlow = new Map<FlowParamItem, boolean>(
      prevFlow.map((r) => [r.item as FlowParamItem, r.is_set]),
    );

    const emaKeys = await keysPaged(SUBNET_EMA_TAO_FLOW_PREFIX);
    const currentEma = new Map<number, { block: number } | null>();
    for (const key of emaKeys) {
      const netuid = netuidFromKey(key, SUBNET_EMA_TAO_FLOW_PREFIX);
      if (netuid === null) continue;
      const raw = await rpc<string | null>("state_getStorage", [key]);
      currentEma.set(netuid, decodeSubnetEmaTaoFlow(raw));
    }

    const flowEvents = [
      ...flowParamEvents({
        current: flowObservations,
        previous: previousFlow,
        blockNumber,
        observedAt,
      }),
      ...emaAdvancedEvents({
        current: currentEma,
        baselineBlock: EMA_FROZEN_BASELINE_BLOCK,
        blockNumber,
        observedAt,
      }),
    ];
    for (const e of flowEvents) {
      await sql`
        INSERT INTO emission_flow_watch
          (item, netuid, is_set, ema_block, block_number, observed_at, predates_capture)
        VALUES (${e.item}, ${e.netuid}, ${e.is_set}, ${e.ema_block},
                ${e.block_number}, ${e.observed_at}, ${e.predates_capture})`;
    }

    // Alertable events are the ones that are NOT a first observation: a
    // predates_capture row just states what was already true when capture
    // began. Reported on stdout so the entrypoint's own log carries it.
    const alertable = flowEvents.filter((e) => !e.predates_capture);
    console.log(
      JSON.stringify({
        block_number: blockNumber,
        gate_param_rows: paramChanges.length,
        subnet_enabled_rows: enabledChanges.length,
        flow_watch_rows: flowEvents.length,
        flow_alertable: alertable.length,
        subnets_seen: currentEnabled.size,
        ema_entries_seen: currentEma.size,
      }),
    );
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
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(
    `sample-emission-gate failed: ${err instanceof Error ? err.message : err}`,
  );
  process.exitCode = 1;
});
