// The emission-gate chain sampler, extracted from
// scripts/sample-emission-gate.ts so the SAME logic runs in two shells: the
// node script (manual runs / Actions dispatch) and the Worker cron that
// replaced the Actions schedule. The 10-minute cadence belongs on Cloudflare
// with the rest of the lane -- the persistence route, the D1 state, and the
// differs already live in this Worker, so a third-party trigger hop bought
// nothing but a failure mode.
//
// Everything here is chain I/O and assembly. All "what counts as a change"
// judgement stays in src/emission-gate-history.ts and
// src/emission-flow-monitor.ts, unit-tested without a chain; this module's
// contract is to hand the sync route EXACTLY what the script handed it.
//
// The extraction is verbatim on the parts that already bit once:
//   - state_getKeysPaged REQUIRES params[2] to be OMITTED, not null (a null
//     makes the RPC proxy 400) -- hence the conditional spread.
//   - TotalIssuance is a u64, NOT a u128 like the three gate parameters;
//     decodeLeU128 rejects its 16-hex value and the halving count silently
//     read as "unknown" on the first live run.
//   - An ABSENT enablement key means ENABLED; only present keys are claimed
//     either way.

import {
  EMISSION_BAR_QUANTILE_STORAGE_KEY,
  EMISSION_GATE_BAR_STORAGE_KEY,
  EMISSION_GATE_EXPONENT_STORAGE_KEY,
  TOTAL_ISSUANCE_STORAGE_KEY,
  decodeLeU128,
  decodeLeU64,
  u64f64U128ToFloat,
} from "./network-parameters.ts";
import {
  FLOW_PARAM_ITEMS,
  decodeSubnetEmaTaoFlow,
  type FlowParamItem,
  type FlowParamObservation,
} from "./emission-flow-monitor.ts";
import type { GateParamReading } from "./emission-gate-history.ts";
import { blockEmissionForIssuance } from "./block-emission.ts";

export const SUBNET_EMISSION_ENABLED_PREFIX =
  "0x658faa385070e074c85bf6b568cf0555c97bb5c5631e5f593b5bd2da84a5fa16";
export const SUBNET_EMA_TAO_FLOW_PREFIX =
  "0x658faa385070e074c85bf6b568cf05559f25bd6b257310b72a9310520b27a626";

export interface EmissionGateSamplerOptions {
  rpcUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

/** The exact body POSTed to /api/v1/internal/emission-gate-sync. Maps travel
 * as [key, value] pair arrays because JSON has no Map; the route rebuilds
 * them. */
export interface EmissionGateSample {
  block_number: number;
  observed_at: number;
  current: GateParamReading;
  current_enabled: [number, boolean][];
  flow_observations: FlowParamObservation[];
  current_ema: [number, { block: number } | null][];
}

/**
 * Storage keys per `state_queryStorageAt` request.
 *
 * Comfortably above the ~72 `SubnetEmissionEnabled` and ~124 `SubnetEmaTaoFlow`
 * keys the chain holds today (measured live 2026-08-05), so both are one call
 * now, while still bounding the request body if the subnet count grows by an
 * order of magnitude. Exported so a test can assert the chunking loop actually
 * runs more than once rather than trusting a single-chunk happy path.
 */
export const STORAGE_BATCH_SIZE = 200;

/** The maps key on `prefix ++ netuid as u16 little-endian`, Identity-hashed
 * (no hasher prefix), so the netuid is simply the last 4 hex chars. */
export function netuidFromKey(key: string, prefix: string): number | null {
  if (!key.startsWith(prefix) || key.length !== prefix.length + 4) return null;
  const le = key.slice(-4);
  return parseInt(le.slice(2, 4) + le.slice(0, 2), 16);
}

/**
 * Read the gate parameters, the per-subnet enablement map, and the flow EMAs
 * from the chain. Throws on any RPC failure -- the caller decides whether
 * that is a skipped tick (the cron) or a failed run (the script); a partial
 * sample must never be handed to the differs as though it were complete.
 */
export async function sampleEmissionGate(
  options: EmissionGateSamplerOptions,
): Promise<EmissionGateSample> {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const now = options.now ?? Date.now;

  async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    const resp = await doFetch(options.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
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

  /**
   * Read many storage values in ONE request, chunked.
   *
   * `state_getStorage` fetches a single value, so asking for it per subnet cost
   * this sampler ~207 calls a tick against an endpoint that serves 100 per
   * client per minute (`RPC_REQUESTS_PER_MINUTE_LIMIT`, measured in #9378).
   * It spent that allowance about six seconds in, threw, and lost the whole
   * sample every ten minutes -- while also spending the raw-capture lanes'
   * share of the same per-client budget (#9477).
   *
   * Chunked rather than one unbounded request: 72 keys is what the chain has
   * today, and a body sized by the subnet count is the kind of thing that works
   * until it abruptly does not.
   */
  async function queryStorage(
    keys: string[],
  ): Promise<Map<string, string | null>> {
    const values = new Map<string, string | null>();
    for (let i = 0; i < keys.length; i += STORAGE_BATCH_SIZE) {
      const chunk = keys.slice(i, i + STORAGE_BATCH_SIZE);
      const pages = await rpc<{ changes?: [string, string | null][] }[] | null>(
        "state_queryStorageAt",
        [chunk],
      );
      for (const page of pages ?? []) {
        for (const [key, value] of page?.changes ?? []) {
          values.set(key, value ?? null);
        }
      }
    }
    // A key the node simply omits is UNSET, which is a real reading, not a
    // missing one -- record it so a caller reading this map cannot mistake
    // "absent from the response" for "never asked for". Same reason
    // state_getStorage's own `null` was never treated as a failure.
    for (const key of keys) if (!values.has(key)) values.set(key, null);
    return values;
  }

  function u64f64At(
    values: Map<string, string | null>,
    storageKey: string,
  ): number | null {
    const raw = values.get(storageKey) ?? null;
    if (raw === null) return null;
    const bits = decodeLeU128(raw);
    return bits === null ? null : u64f64U128ToFloat(bits);
  }

  const header = await rpc<{ number: string }>("chain_getHeader", []);
  const blockNumber = parseInt(header.number, 16);
  const observedAt = now();

  const paramValues = await queryStorage([
    EMISSION_GATE_BAR_STORAGE_KEY,
    EMISSION_BAR_QUANTILE_STORAGE_KEY,
    EMISSION_GATE_EXPONENT_STORAGE_KEY,
    TOTAL_ISSUANCE_STORAGE_KEY,
  ]);
  const bar = u64f64At(paramValues, EMISSION_GATE_BAR_STORAGE_KEY);
  const quantile = u64f64At(paramValues, EMISSION_BAR_QUANTILE_STORAGE_KEY);
  const exponent = u64f64At(paramValues, EMISSION_GATE_EXPONENT_STORAGE_KEY);
  const totalIssuanceRaw = paramValues.get(TOTAL_ISSUANCE_STORAGE_KEY) ?? null;

  // Halvings, not the emission itself: the TAO-per-block figure drifts with
  // issuance, but the HALVING COUNT is a step function that moves a handful
  // of times in the network's life -- which is what belongs in a change log.
  const issuanceBits = decodeLeU64(totalIssuanceRaw);
  const halvings = blockEmissionForIssuance(issuanceBits)?.halvings ?? null;

  const current: GateParamReading = {
    emission_gate_bar: bar,
    emission_bar_quantile: quantile,
    // Raw, NOT the effective value: `h` unset means the runtime default 3,
    // and collapsing the two here would record a governance change the
    // moment someone explicitly sets it TO 3.
    emission_gate_exponent: exponent,
    block_emission_halvings: halvings,
  };

  const enabledKeys = await keysPaged(SUBNET_EMISSION_ENABLED_PREFIX);
  const enabledValues = await queryStorage(enabledKeys);
  const currentEnabled = new Map<number, boolean>();
  for (const key of enabledKeys) {
    const netuid = netuidFromKey(key, SUBNET_EMISSION_ENABLED_PREFIX);
    if (netuid === null) continue;
    const raw = enabledValues.get(key) ?? null;
    // 0x00 is disabled; anything else present is enabled.
    currentEnabled.set(netuid, raw !== "0x00");
  }

  const flowEntries = Object.entries(FLOW_PARAM_ITEMS) as [
    FlowParamItem,
    string,
  ][];
  const flowValues = await queryStorage(flowEntries.map(([, key]) => key));
  const flowObservations: FlowParamObservation[] = flowEntries.map(
    ([item, key]) => ({ item, raw: flowValues.get(key) ?? null }),
  );

  const emaKeys = await keysPaged(SUBNET_EMA_TAO_FLOW_PREFIX);
  const emaValues = await queryStorage(emaKeys);
  const currentEma = new Map<number, { block: number } | null>();
  for (const key of emaKeys) {
    const netuid = netuidFromKey(key, SUBNET_EMA_TAO_FLOW_PREFIX);
    if (netuid === null) continue;
    currentEma.set(netuid, decodeSubnetEmaTaoFlow(emaValues.get(key) ?? null));
  }

  return {
    block_number: blockNumber,
    observed_at: observedAt,
    current,
    current_enabled: [...currentEnabled],
    flow_observations: flowObservations,
    current_ema: [...currentEma],
  };
}
