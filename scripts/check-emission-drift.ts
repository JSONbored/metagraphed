// #8749: hold the emission reconstruction against LIVE chain state.
//
//     STEP=emission-drift-check node scripts/check-emission-drift.ts
//
// The CI harness (tests/emission-pipeline.test.ts) pins OUR ARITHMETIC against
// a committed fixture. It cannot notice the chain changing underneath it — and
// the runtime ships every two to three days (#8702). This is the other half:
// the same reconstruction, the same four identity checks, run against live
// state on the ingestion cadence.
//
// ONE IMPLEMENTATION, TWO CALLERS. Both the test and this script import
// src/emission-pipeline.ts. A monitor with its own copy of the pipeline would
// drift from the thing it is monitoring, which is the failure mode that makes
// monitors worse than nothing.
//
// A divergence means one of three things, all of which we want to know about
// immediately: our capture broke, a runtime upgrade changed the pipeline, or a
// dormant switch was flipped (#8750). The alert names which invariant broke so
// the reader is not left to guess between them.
//
// Zero alerts is the correct steady state and means the reconstruction still
// holds -- not that the monitor is broken. It prints a summary line every run
// for exactly that reason.

import {
  DEFAULT_EMISSION_GATE_EXPONENT,
  decodeLeU64,
  decodeLeU128,
  u64f64U128ToFloat,
  u96f32U128ToFloat,
} from "../src/network-parameters.ts";
import { blockEmissionForIssuance } from "../src/block-emission.ts";
import {
  emissionIdentityChecks,
  reconstructEmissionPipeline,
  recomputeEmissionGateBar,
  SUBNET_SHARE_TOLERANCE,
  type SubnetPipelineInput,
} from "../src/emission-pipeline.ts";

// Required, with no committed default -- scan:public-safety bans private and
// loopback URLs in the repo, and a baked-in host is wrong for every deployment
// but one. Must be a node AT CHAIN TIP: the archive node is still syncing and
// would reconstruct months-old state as if it were current.
function requiredRpcUrl(): string {
  const url = process.env.EMISSION_DRIFT_RPC_URL;
  if (url) return url;
  console.error(
    "EMISSION_DRIFT_RPC_URL is required: the RPC endpoint of a node AT CHAIN TIP.",
  );
  process.exit(1);
}

const RPC_URL = requiredRpcUrl();
const RPC_TIMEOUT_MS = Number(
  process.env.EMISSION_DRIFT_RPC_TIMEOUT_MS ?? 20_000,
);
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

let rpcId = 0;

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: (rpcId += 1), method, params }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  const body = (await response.json()) as { result?: T; error?: unknown };
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result as T;
}

function netuidSuffix(netuid: number): string {
  return (
    (netuid % 256).toString(16).padStart(2, "0") +
    Math.floor(netuid / 256)
      .toString(16)
      .padStart(2, "0")
  );
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

async function main(): Promise<void> {
  // Pinned: theta recomputes on the 360-block boundary and the price EMAs move
  // every block, so unpinned reads would mix states that never coexisted and
  // report a capture artefact as chain drift.
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
    console.error("ALERT: could not derive block emission from TotalIssuance");
    process.exit(1);
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
      const error = Math.abs(share - (row.final_share ?? 0));
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
      .map((r) => r.weighted_share ?? 0),
    quantile,
  );

  const failed = checks.filter((c) => !c.ok);
  console.log(
    JSON.stringify({
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
    }),
  );

  if (failed.length === 0 && !shareDrift) return;

  const reasons = [
    ...failed.map((c) => `${c.name} — ${c.detail}`),
    ...(shareDrift
      ? [
          `per-subnet reconstruction drift — netuid ${worst.netuid} off by ${worst.error.toExponential(3)} (tolerance ${SUBNET_SHARE_TOLERANCE})`,
        ]
      : []),
  ];
  for (const reason of reasons) console.error(`ALERT: ${reason}`);

  // Same optional-webhook convention as sample-emission-gate.ts: quietly
  // no-ops when unset rather than failing the run.
  const webhook = process.env.LIVE_ALERT_WEBHOOK_URL;
  if (webhook) {
    try {
      await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          content:
            `🚨 metagraphed: the v440 emission reconstruction diverged at block ${blockNumber}.\n` +
            reasons.map((r) => `• ${r}`).join("\n") +
            `\nOne of: our capture broke, a runtime upgrade changed the pipeline, ` +
            `or a dormant switch was flipped (#8750). Published emission ` +
            `decomposition is suspect until this is explained (#8749).`,
        }),
      });
    } catch (err) {
      console.error(
        `alert webhook failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // Non-zero exit so the systemd unit records a failure -- a monitor whose
  // alerts only go to a webhook is invisible when the webhook is misconfigured.
  process.exit(1);
}

await main();
