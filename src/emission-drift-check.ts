// The live emission-drift check, extracted from
// scripts/check-emission-drift.ts so the SAME reconstruction-vs-chain
// comparison runs in two shells: the node script (manual runs / Actions
// dispatch) and the Worker cron that replaced the 30-minute Actions schedule.
//
// ONE IMPLEMENTATION, THREE CALLERS. The CI harness pins the arithmetic
// against a committed fixture; the script and the cron hold the same
// arithmetic against live state. All of them import src/emission-pipeline.ts
// -- a monitor with its own copy of the pipeline would drift from the thing
// it is monitoring, which is the failure mode that makes monitors worse than
// nothing.
//
// This module reads, reconstructs, and judges. What to DO with a divergence
// stays with the caller: the script prints and exits non-zero, the cron
// throws so the scheduled-run scaffolding records the exception. Reads are
// pinned to one block hash: theta recomputes on the 360-block boundary and
// the price EMAs move every block, so unpinned reads would mix states that
// never coexisted and report a capture artefact as chain drift.

import {
  DEFAULT_EMISSION_GATE_EXPONENT,
  decodeLeU64,
  decodeLeU128,
  u64f64U128ToFloat,
  u96f32U128ToFloat,
} from "./network-parameters.ts";
import { blockEmissionForIssuance } from "./block-emission.ts";
import {
  emissionIdentityChecks,
  reconstructEmissionPipeline,
  recomputeEmissionGateBar,
  SUBNET_SHARE_TOLERANCE,
  type SubnetPipelineInput,
} from "./emission-pipeline.ts";

const MAX_NETUID = 128;

/** twox128("SubtensorModule"). */
const PALLET = "658faa385070e074c85bf6b568cf0555";

const MAPS = {
  moving_price: "1abf1b0f4fd14f7b72ee50f9d91d5915",
  miner_burned: "1eac6222ebba7feba4ca36a94736815e",
  emission_enabled: "c97bb5c5631e5f593b5bd2da84a5fa16",
  first_emission_block: "e4cfee4e36f2419d8863a3fda65c428f",
  subtoken_enabled: "e9348e9224ea06c9c2da12ce69e619c5",
  registration_allowed: "d5fe74da02c7b4bbb340fb368eee3e77",
  tao_in_emission: "dd62ae7237581e8f6a684f1ecae06215",
  excess_tao: "857b0a5b920bc5e41cb0695a4b7d38e7",
} as const;

const VALUES = {
  emission_gate_bar: "7c9b0d2964cc73e7519676c3cc4d5df9",
  emission_bar_quantile: "a772007dde2ed63e0f21b5f9d7f16650",
  emission_gate_exponent: "88c70e8dd0cf4af3aeb977ba2eee1df4",
  total_issuance: "57c875e4cff74148e4628f264b974c80",
} as const;

export interface EmissionDriftCheckOptions {
  rpcUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** The summary line every run emits -- zero alerts is the correct steady
 * state, and a healthy run must still be legible. */
export interface EmissionDriftSummary {
  block_number: number;
  last_gate_block: number;
  theta: number;
  theta_recomputed: number | null;
  exponent: number;
  quantile: number;
  block_emission_rao: string;
  halvings: number;
  eligible: number;
  disabled: number;
  mean_share_error: number;
  max_share_error: number;
  max_share_error_netuid: number;
  identities_failed: number;
}

export interface EmissionDriftResult {
  summary: EmissionDriftSummary;
  /** Human-readable divergences; empty means the reconstruction holds. */
  reasons: string[];
}

function netuidSuffix(netuid: number): string {
  return (
    (netuid % 256).toString(16).padStart(2, "0") +
    Math.floor(netuid / 256)
      .toString(16)
      .padStart(2, "0")
  );
}

/**
 * Reconstruct the emission pipeline from live chain state and hold it against
 * the four identity checks plus the per-subnet share tolerance CI enforces.
 * Throws on any RPC failure or an underivable block emission -- a partial
 * read must never be scored as if it were a complete one.
 */
export async function checkEmissionDrift(
  options: EmissionDriftCheckOptions,
): Promise<EmissionDriftResult> {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  let rpcId = 0;

  async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    const response = await doFetch(options.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: (rpcId += 1),
        method,
        params,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
    const body = (await response.json()) as { result?: T; error?: unknown };
    if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
    return body.result as T;
  }

  async function readMap(
    itemHash: string,
    blockHash: string,
  ): Promise<Map<number, string>> {
    const keys = Array.from(
      { length: MAX_NETUID },
      (_, n) => `0x${PALLET}${itemHash}${netuidSuffix(n)}`,
    );
    const result = await rpc<{ changes: [string, string | null][] }[]>(
      "state_queryStorageAt",
      [keys, blockHash],
    );
    const out = new Map<number, string>();
    for (const [key, value] of result[0]?.changes ?? []) {
      if (value === null) continue;
      const suffix = key.slice(-4);
      out.set(
        Number.parseInt(suffix.slice(0, 2), 16) +
          Number.parseInt(suffix.slice(2, 4), 16) * 256,
        value,
      );
    }
    return out;
  }

  const header = await rpc<{ number: string }>("chain_getHeader", []);
  const blockNumber = Number.parseInt(header.number, 16);
  const blockHash = await rpc<string>("chain_getBlockHash", [blockNumber]);

  const maps: Record<string, Map<number, string>> = {};
  for (const [name, hash] of Object.entries(MAPS)) {
    maps[name] = await readMap(hash, blockHash);
  }
  const values: Record<string, string | null> = {};
  for (const [name, hash] of Object.entries(VALUES)) {
    values[name] = await rpc<string | null>("state_getStorage", [
      `0x${PALLET}${hash}`,
      blockHash,
    ]);
  }

  const theta = u64f64U128ToFloat(decodeLeU128(values.emission_gate_bar) ?? 0n);
  const quantile = u64f64U128ToFloat(
    decodeLeU128(values.emission_bar_quantile) ?? 0n,
  );
  const exponent =
    values.emission_gate_exponent === null
      ? DEFAULT_EMISSION_GATE_EXPONENT
      : u64f64U128ToFloat(decodeLeU128(values.emission_gate_exponent) ?? 0n);
  const blockEmission = blockEmissionForIssuance(
    decodeLeU64(values.total_issuance),
  );
  if (!blockEmission) {
    // Never cached and never assumed: the identity's right-hand side moves
    // discontinuously at a halving.
    throw new Error("could not derive block emission from TotalIssuance");
  }

  const netuids = Array.from({ length: MAX_NETUID }, (_, i) => i);
  const inputs: SubnetPipelineInput[] = netuids.map((netuid) => {
    const price = decodeLeU128(maps.moving_price.get(netuid));
    const burned = decodeLeU128(maps.miner_burned.get(netuid));
    const enabled = maps.emission_enabled.get(netuid);
    const first = decodeLeU64(maps.first_emission_block.get(netuid));
    return {
      netuid,
      moving_price: price === null ? 0 : u64f64U128ToFloat(price),
      miner_burned: burned === null ? 0 : u96f32U128ToFloat(burned),
      // ABSENT MEANS ENABLED -- the default that inverts if read as presence.
      emission_enabled: enabled === undefined ? true : enabled !== "0x00",
      first_emission_block: first === null ? null : Number(first),
      subtoken_enabled: maps.subtoken_enabled.get(netuid) === "0x01",
      registration_allowed: maps.registration_allowed.get(netuid) === "0x01",
    };
  });

  const observed = netuids.map((netuid) => ({
    netuid,
    emission_enabled: inputs[netuid].emission_enabled,
    tao_in_emission_rao: decodeLeU64(maps.tao_in_emission.get(netuid)) ?? 0n,
    excess_tao_rao: decodeLeU64(maps.excess_tao.get(netuid)) ?? 0n,
  }));

  const reconstruction = reconstructEmissionPipeline({
    subnets: inputs,
    parameters: { theta, exponent },
  });

  const checks = emissionIdentityChecks({
    subnets: observed,
    reconstruction,
    blockEmissionRao: blockEmission.rao_per_block,
    quantile,
  });

  // Per-subnet reconstruction error, against the same tolerance CI holds.
  const totalObserved = observed.reduce(
    (sum, o) => sum + o.tao_in_emission_rao + o.excess_tao_rao,
    0n,
  );
  let worst = { netuid: -1, error: 0 };
  let errorSum = 0;
  let counted = 0;
  if (totalObserved > 0n) {
    for (const row of reconstruction.subnets) {
      if (row.ineligible_reason !== null) continue;
      const o = observed[row.netuid];
      const share =
        Number(o.tao_in_emission_rao + o.excess_tao_rao) /
        Number(totalObserved);
      // Stage 5 sets final_share on every eligible row; null survives only on
      // ineligible rows, which the continue above already dropped.
      const error = Math.abs(share - (row.final_share as number));
      if (error > worst.error) worst = { netuid: row.netuid, error };
      errorSum += error;
      counted += 1;
    }
  }
  const meanError = counted > 0 ? errorSum / counted : 0;
  const shareDrift = worst.error > SUBNET_SHARE_TOLERANCE;

  // The bar the runtime WOULD write for the current distribution, alongside
  // the one it is actually gating with. Reported, never substituted: theta is
  // stale by design between recomputes, so a gap here is information, not a
  // fault. A gap that stops closing after a 360-block boundary is a fault.
  const recomputedBar = recomputeEmissionGateBar(
    reconstruction.subnets
      .filter((r) => r.ineligible_reason === null)
      // Stage 2 sets weighted_share on every eligible row; null survives only
      // on the ineligible rows the filter just dropped.
      .map((r) => r.weighted_share as number),
    quantile,
  );

  const failed = checks.filter((c) => !c.ok);
  const reasons = [
    ...failed.map((c) => `${c.name} — ${c.detail}`),
    ...(shareDrift
      ? [
          `per-subnet reconstruction drift — netuid ${worst.netuid} off by ${worst.error.toExponential(3)} (tolerance ${SUBNET_SHARE_TOLERANCE})`,
        ]
      : []),
  ];

  return {
    summary: {
      block_number: blockNumber,
      last_gate_block: blockNumber - (blockNumber % 360),
      theta,
      theta_recomputed: recomputedBar,
      exponent,
      quantile,
      block_emission_rao: blockEmission.rao_per_block.toString(),
      halvings: blockEmission.halvings,
      eligible: reconstruction.eligible_count,
      disabled: reconstruction.disabled_count,
      mean_share_error: meanError,
      max_share_error: worst.error,
      max_share_error_netuid: worst.netuid,
      identities_failed: failed.length,
    },
    reasons,
  };
}
