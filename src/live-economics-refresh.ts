// The live-economics refresh as a Worker cron -- the last GitHub Actions data
// lane, moved onto Cloudflare with the rest of them.
//
// WHAT THIS WRITES, AND WHY THAT IS DELICATE. KV `economics:current` is the
// LIVE tier for /api/v1/economics, /api/v1/subnets/{netuid}'s economics
// overlay and /api/v1/chain/emission-pipeline. resolveLiveEconomics prefers it
// over the published R2 economics.json whenever it passes four gates
// (contract_version, captured_at freshness, row count vs the summary, and
// emission_share summing to ~1) -- and NONE of those gates look at the
// per-subnet fields. So a writer that omits a field does not degrade to R2: it
// SHADOWS a complete R2 artifact with an incomplete blob, and the field simply
// disappears from the API. That has already happened twice (chain_state, then
// every alpha_price_change_*), which is why this module builds the blob with
// the SAME scripts/lib/economics-artifacts.ts builder the R2 artifact is built
// with, rather than assembling a second shape by hand.
//
// WHERE THE INPUTS COME FROM. The retired workflow shelled out to a Python
// bittensor-SDK capture (scripts/fetch-native-subnets.py, one bulk
// get_all_metagraphs_info plus fourteen pinned storage reads) and then to
// scripts/refresh-economics.ts. A Worker has no SDK, so every value is read
// the way src/emission-drift-check.ts already reads the pipeline maps -- one
// `state_queryStorageAt` per storage ITEM across all netuids, pinned to one
// block hash (src/subtensor-pinned-storage.ts) -- with the two aggregates that
// are genuinely per-UID (stake and the validator/miner split) taken from the
// D1 `neurons` table the poller Container keeps on a 15-minute tick, rather
// than re-walking ~33k double-map entries over RPC.
//
// That makes the whole sweep ~22 RPC calls plus two D1 queries, and it makes
// registration_allowed / alpha_price_tao PINNED where the SDK path read them
// off the bulk call at its own height. The two `*_pinned` companion fields
// (#8744) stay in the row regardless: they are a published pair whose whole
// purpose is to let a reader see the two instants, and dropping one because
// this writer happens to make them equal would break the shape for the R2
// tier that still has two.
//
// THE D1 READS GO THROUGH THE BINDING, not the Cloudflare HTTP API. That is
// not a preference: the repo's CLOUDFLARE_API_TOKEN has no D1 read permission,
// which is why the Actions path's alpha_price_change_* fields 403'd into nulls
// (#9189) -- and null change fields on a KV blob that shadows R2 look exactly
// like "no history exists". The binding has no token to be missing.
//
// TOLERANCE. Any chain or D1 failure, and any blob that fails the
// shouldPublishEconomics content floor, SKIPS the KV write and returns a
// summary. The last good value survives, and the serve path falls back
// KV -> R2 either way. This lane never throws: a refresh that could not read
// the chain is one stale window, and a cron that throws is a cron whose result
// nobody can read.

import { buildEconomicsArtifact } from "../scripts/lib/economics-artifacts.ts";
import { shouldPublishEconomics } from "../scripts/economics-floor.ts";
import { alphaPriceHistoryQuery } from "../scripts/lib/load-alpha-price-history.ts";
import { indexAlphaPriceHistoryByNetuid } from "./alpha-price-change.ts";
import { CONTRACT_VERSION } from "./contracts.ts";
import { KV_ECONOMICS_CURRENT } from "./kv-keys.ts";
import {
  decodeLeU64,
  decodeLeU128,
  u64f64U128ToFloat,
  u96f32U128ToFloat,
} from "./network-parameters.ts";
import { encodeAccountId32 } from "./ss58.ts";
import { createSubtensorPinnedStorage } from "./subtensor-pinned-storage.ts";
import type { StorageReadResult } from "../workers/storage.ts";

type Row = Record<string, unknown>;

/** The published registry index the subnet list (netuid/slug/name/block) comes
 * from -- the same artifact src/github-signals-sync.ts resolves its repo list
 * from, read through the same internal reader. Never the repo filesystem: a
 * Worker has none. */
export const LIVE_ECONOMICS_SUBNETS_ARTIFACT_PATH = "/metagraph/subnets.json";

/** Public archive endpoint, the default every other chain-reading lane here
 * uses. Overridable per-deploy via LIVE_ECONOMICS_RPC_URL. */
export const LIVE_ECONOMICS_DEFAULT_RPC_URL =
  "https://archive.chain.opentensor.ai";

/**
 * twox128(<item name>) for every per-netuid map this sweep reads. Hardcoded
 * digests rather than runtime hashing, matching every other storage reader in
 * this repo (src/subnet-burn.ts, src/network-parameters.ts,
 * src/emission-drift-check.ts): a pallet item's digest is fixed for the life
 * of the item, and the names are recorded here so the mapping stays auditable.
 *
 * The eight items the emission harness also reads carry IDENTICAL digests
 * there -- held against tests/fixtures/emission-pipeline.json's own
 * `item_hashes` by tests/live-economics-refresh.test.ts, so the two lanes can
 * never drift onto different keys for the same storage item.
 */
export const ECONOMICS_STORAGE_MAPS = {
  /** SubtensorModule.SubnetAlphaIn -- u64 rao. */
  alpha_in_pool: "2ce12f7007574647d692ac7edf8b7a53",
  /** SubtensorModule.SubnetAlphaOut -- u64 rao. */
  alpha_out_pool: "7837978cc6746112a2c9e680a18cfcb9",
  /** SubtensorModule.SubnetTAO -- u64 rao. */
  tao_in_pool: "7a57dce016211512d1700561066b85a3",
  /** SubtensorModule.SubnetVolume -- u128 rao (wider than the pools above). */
  subnet_volume: "3c3226e141696000b4b239c65bc2b2b4",
  /** SubtensorModule.MaxAllowedUids -- u16. */
  max_uids: "fabe6b131d9fa6e6d6cacbe7586c3b8a",
  /** SubtensorModule.MaxAllowedValidators -- u16. */
  max_validators: "741b883d2519eed91857993bfd4df0ba",
  /** SubtensorModule.SubnetOwner -- AccountId32. */
  owner_coldkey: "36e3e82152c8758267395fe524fbbd16",
  /** SubtensorModule.SubnetOwnerHotkey -- AccountId32. */
  owner_hotkey: "68b7553499633fe05caf4d8a51aefe5c",
  /** SubtensorModule.Burn -- u64 rao, the live registration cost. */
  registration_cost: "01be1755d08418802946bca51b686325",
  /** SubtensorModule.SubnetMovingPrice -- fixed point, see decodeMovingPrice. */
  moving_price: "1abf1b0f4fd14f7b72ee50f9d91d5915",
  /** SubtensorModule.NetworkRegistrationAllowed -- bool, absent is FALSE. */
  registration_allowed: "d5fe74da02c7b4bbb340fb368eee3e77",
  /** SubtensorModule.MinerBurned -- U96F32 FRACTION, never rao. */
  miner_burned: "1eac6222ebba7feba4ca36a94736815e",
  /** SubtensorModule.SubnetEmissionEnabled -- bool, absent is TRUE. */
  emission_enabled: "c97bb5c5631e5f593b5bd2da84a5fa16",
  /** SubtensorModule.SubtokenEnabled -- bool, absent is FALSE. */
  subtoken_enabled: "e9348e9224ea06c9c2da12ce69e619c5",
  /** SubtensorModule.FirstEmissionBlockNumber -- u64 block height. */
  first_emission_block: "e4cfee4e36f2419d8863a3fda65c428f",
  /** SubtensorModule.SubnetTaoInEmission -- u64 rao. */
  tao_in_emission: "dd62ae7237581e8f6a684f1ecae06215",
  /** SubtensorModule.SubnetExcessTao -- u64 rao. */
  excess_tao: "857b0a5b920bc5e41cb0695a4b7d38e7",
  /** SubtensorModule.SubnetAlphaInEmission -- u64 rao. */
  alpha_in_emission: "1905df3b2516a166b6f9fba54fef1cd8",
  /** SubtensorModule.SubnetAlphaOutEmission -- u64 rao. NOT a constant 1.0:
   * it is a per-subnet halving curve that reads 1.0 today only because no
   * subnet has crossed its first threshold. */
  alpha_out_emission: "25257fbc5458419b7bc7e8c44c521521",
} as const;

/** Network-level (non-map) items, read once at the same pinned block. */
export const ECONOMICS_STORAGE_VALUES = {
  /** SubtensorModule.TotalIssuance -- u64 rao. */
  total_issuance: "57c875e4cff74148e4628f264b974c80",
  /** SubtensorModule.EmissionGateBar -- U64F64 (theta). */
  emission_gate_bar: "7c9b0d2964cc73e7519676c3cc4d5df9",
  /** SubtensorModule.EmissionBarQuantile -- U64F64. */
  emission_bar_quantile: "a772007dde2ed63e0f21b5f9d7f16650",
  /** SubtensorModule.EmissionGateExponent -- U64F64; UNSET is not zero. */
  emission_gate_exponent: "88c70e8dd0cf4af3aeb977ba2eee1df4",
} as const;

type MapName = keyof typeof ECONOMICS_STORAGE_MAPS;
type StorageMaps = Record<MapName, Map<number, string>>;

/** BigInt rao -> Number TAO, split in BigInt space so the integer part stays
 * exact (the network-wide sums are far past 2^53 at rao precision). Mirrors
 * the private helper of the same name in src/network-parameters.ts and the
 * `rao_to_tao_exact` the Python capture used. */
export function raoToTao(rao: bigint): number {
  return Number(rao / 1_000_000_000n) + Number(rao % 1_000_000_000n) / 1e9;
}

/** A u64 rao map entry as TAO. `absentAsZero` distinguishes the two real
 * cases: a pool reserve that is simply not there is unknown (null), while a
 * disabled subnet's emission channel is a measured zero -- 57 subnets read 0
 * on both TAO channels and coercing that to null would hide a real reading. */
export function decodeRaoTao(
  raw: string | undefined,
  absentAsZero = false,
): number | null {
  const rao = decodeLeU64(raw);
  if (rao === null) return absentAsZero ? 0 : null;
  return raoToTao(rao);
}

/** A little-endian unsigned integer of `byteLen` bytes as a Number. Used for
 * the two u16 hyperparameters, which are small by construction. */
export function decodeLeUintNumber(
  raw: string | undefined,
  byteLen: number,
): number | null {
  if (typeof raw !== "string" || !raw.startsWith("0x")) return null;
  const body = raw.slice(2);
  if (body.length < byteLen * 2) return null;
  let value = 0;
  for (let i = byteLen * 2 - 2; i >= 0; i -= 2) {
    const byte = Number.parseInt(body.slice(i, i + 2), 16);
    if (!Number.isFinite(byte)) return null;
    value = value * 256 + byte;
  }
  return value;
}

/**
 * A Substrate bool where ABSENCE IS MEANINGFUL, not missing data.
 *
 * SubnetEmissionEnabled defaults to TRUE -- absent storage is enabled and
 * `0x00` is disabled -- so a naive "is the key set" check inverts the meaning
 * for the ~57 subnets that carry no entry at all. NetworkRegistrationAllowed
 * and SubtokenEnabled have no true-by-default behaviour and pass `false`.
 */
export function decodeOptionalBool(
  raw: string | undefined,
  fallback: boolean,
): boolean {
  if (raw === undefined) return fallback;
  if (raw === "0x00") return false;
  if (raw === "0x01") return true;
  return fallback;
}

/** AccountId32 storage value -> SS58, or null when absent/malformed. */
export function decodeAccountId(raw: string | undefined): string | null {
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(raw)) return null;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    bytes[i] = Number.parseInt(raw.slice(2 + i * 2, 4 + i * 2), 16);
  }
  return encodeAccountId32(bytes);
}

/**
 * SubnetMovingPrice, decoded BOTH ways it is published -- and they differ by
 * exactly 2^32, which is not a bug in either of them.
 *
 * `alpha_price_tao` is the published price whose meaning ADR 0023 decision 1
 * fixes as-is: the bittensor SDK reads this word as a 32-bit-fraction fixed
 * point, so the value the API has always served is bits / 2^32, carried at rao
 * precision because it arrived as a Balance. Verified against the live tier:
 * netuid 64 served 0.083135901 against a stored word of the matching height.
 *
 * `moving_price_pinned` is the SEPARATE #8744 reading the emission pipeline
 * consumes, decoded at U64F64 exactly as src/emission-drift-check.ts and
 * scripts/fetch-native-subnets.py decode it. The reconstruction only ever uses
 * it as a ratio against the other subnets' values, so the scale cancels --
 * and the two fields exist separately precisely because they are not
 * interchangeable. Changing either scale here would silently redefine a
 * published field, so both are reproduced exactly.
 */
export function decodeMovingPrice(raw: string | undefined): {
  alpha_price_tao: number | null;
  moving_price_pinned: number | null;
} {
  const bits = decodeLeU128(raw);
  if (bits === null)
    return { alpha_price_tao: null, moving_price_pinned: null };
  return {
    // Truncate to rao in BigInt space, matching the Balance the SDK path
    // produced, rather than publishing a float with sub-rao digits.
    alpha_price_tao: raoToTao((bits * 1_000_000_000n) >> 32n),
    moving_price_pinned: u64f64U128ToFloat(bits),
  };
}

/** Per-netuid aggregates from the D1 `neurons` table. */
export interface NeuronAggregate {
  uid_count: number;
  validator_count: number;
  total_stake_alpha: number | null;
  max_stake_alpha: number | null;
}

/**
 * The per-UID half of the row, aggregated in SQL rather than pulled row by
 * row: `neurons` is latest-only and holds ~33k rows across the network, and
 * the four numbers this lane needs are a GROUP BY.
 *
 * `stake_tao` is the per-UID ALPHA stake despite the column name (the
 * repo-wide `*_tao`-holds-alpha naming, #8945) -- which is what makes it the
 * right source for `total_stake_alpha` / `max_stake_alpha`. Verified against
 * the live tier: netuid 64 aggregated to 3,895,629.026 / 2,114,915.958 against
 * a served 3,895,631.261 / 2,114,916.231 minutes apart.
 */
export const NEURON_AGGREGATE_QUERY =
  "SELECT netuid, COUNT(*) AS uid_count, " +
  "SUM(CASE WHEN validator_permit = 1 THEN 1 ELSE 0 END) AS validator_count, " +
  "SUM(stake_tao) AS total_stake_alpha, MAX(stake_tao) AS max_stake_alpha " +
  "FROM neurons GROUP BY netuid";

/** SQLite returns NULL for SUM/MAX over an empty group. `Number(null)` is a
 * perfectly finite 0, so the null check has to come FIRST -- otherwise "we
 * measured nothing" is published as "we measured zero stake". */
function finiteOrNull(value: unknown): number | null {
  if (value == null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function indexNeuronAggregates(
  rows: Row[] | null | undefined,
): Map<number, NeuronAggregate> {
  const out = new Map<number, NeuronAggregate>();
  for (const row of Array.isArray(rows) ? rows : []) {
    const netuid = Number(row?.netuid);
    if (!Number.isInteger(netuid) || netuid < 0) continue;
    out.set(netuid, {
      uid_count: Number(row.uid_count) || 0,
      validator_count: Number(row.validator_count) || 0,
      total_stake_alpha: finiteOrNull(row.total_stake_alpha),
      max_stake_alpha: finiteOrNull(row.max_stake_alpha),
    });
  }
  return out;
}

/**
 * Did the chain answer ANYTHING for this netuid?
 *
 * A netuid the registry index lists but that every one of the storage maps
 * came back empty for is not a subnet with all-zero economics -- it is a
 * netuid this sweep learned nothing about, and emitting a row of nulls and
 * zeroes for it would publish a confident answer built from no reading at all.
 * Omitting it also keeps `summary.with_economics_count` honest, which is what
 * the content floor (and resolveLiveEconomics's own row-count gate) is
 * measured against: a node that answers nothing produces zero rows and the
 * floor blocks the write, instead of a full-looking blob of empty subnets
 * shadowing the complete R2 artifact.
 */
export function subnetHasChainData(netuid: number, maps: StorageMaps): boolean {
  for (const map of Object.values(maps)) {
    if (map.has(netuid)) return true;
  }
  return false;
}

/**
 * One subnet's `economics` block, in the shape the artifact builder consumes.
 *
 * The key set is the contract here -- schemas-src/shared.ts's
 * SubnetEconomicsSchema is `.strict()`, and the KV tier shadows R2, so a
 * missing key is a field that vanishes from the API rather than one that falls
 * back. tests/live-economics-refresh.test.ts holds this against the builder's
 * own output and against that schema.
 */
export function buildSubnetEconomics(
  netuid: number,
  maps: StorageMaps,
  neurons: NeuronAggregate | undefined,
): Row {
  const get = (name: MapName) => maps[name].get(netuid);
  const { alpha_price_tao, moving_price_pinned } = decodeMovingPrice(
    get("moving_price"),
  );
  const registrationAllowed = decodeOptionalBool(
    get("registration_allowed"),
    false,
  );
  const validatorCount = neurons?.validator_count ?? 0;
  const minerBurnedBits = decodeLeU128(get("miner_burned"));
  const firstEmissionBlock = decodeLeU64(get("first_emission_block"));
  const subnetVolumeRao = decodeLeU128(get("subnet_volume"));
  return {
    // --- pool + hyperparameter reads -----------------------------------
    alpha_in_pool: decodeRaoTao(get("alpha_in_pool")),
    alpha_out_pool: decodeRaoTao(get("alpha_out_pool")),
    alpha_price_tao,
    max_stake_alpha: neurons?.max_stake_alpha ?? null,
    max_uids: decodeLeUintNumber(get("max_uids"), 2) ?? 0,
    max_validators: decodeLeUintNumber(get("max_validators"), 2) ?? 0,
    // num_uids - validators, floored at 0, exactly as the SDK path derived it.
    miner_count: Math.max(0, (neurons?.uid_count ?? 0) - validatorCount),
    owner_coldkey: decodeAccountId(get("owner_coldkey")),
    owner_hotkey: decodeAccountId(get("owner_hotkey")),
    registration_allowed: registrationAllowed,
    registration_cost_tao: decodeRaoTao(get("registration_cost")),
    subnet_volume_tao:
      subnetVolumeRao === null ? null : raoToTao(subnetVolumeRao),
    tao_in_pool_tao: decodeRaoTao(get("tao_in_pool")),
    total_stake_alpha: neurons?.total_stake_alpha ?? null,
    validator_count: validatorCount,
    // --- v440 emission-pipeline inputs (#8743/#8744) --------------------
    alpha_in_emission: decodeRaoTao(get("alpha_in_emission"), true),
    alpha_out_emission: decodeRaoTao(get("alpha_out_emission"), true),
    emission_enabled: decodeOptionalBool(get("emission_enabled"), true),
    excess_tao: decodeRaoTao(get("excess_tao"), true),
    first_emission_block:
      firstEmissionBlock === null ? null : Number(firstEmissionBlock),
    miner_burned_fraction:
      minerBurnedBits === null ? null : u96f32U128ToFloat(minerBurnedBits),
    moving_price_pinned,
    // Read at the pinned block here, so it agrees with its own companion by
    // construction. The pair is kept because the R2 tier still has two
    // instants and the published shape is shared.
    registration_allowed_pinned: registrationAllowed,
    subtoken_enabled: decodeOptionalBool(get("subtoken_enabled"), false),
    tao_in_emission_tao: decodeRaoTao(get("tao_in_emission"), true),
  };
}

interface D1Like {
  prepare(sql: string): { all(): Promise<{ results?: Row[] } | null> };
}

interface KvLike {
  put(key: string, value: string): Promise<unknown>;
}

export interface LiveEconomicsRefreshDeps {
  readArtifact?: (env: Env, path: string) => Promise<StorageReadResult>;
  fetchImpl?: typeof fetch;
  /** Clock seam; stamps generated_at / captured_at. */
  now?: () => number;
  timeoutMs?: number;
}

export interface LiveEconomicsRefreshResult {
  ok: boolean;
  written?: boolean;
  reason?: string;
  block?: number;
  subnet_count?: number;
  with_economics_count?: number;
  captured_at?: string;
}

/**
 * One refresh tick: read the registry index, sweep the chain at one pinned
 * block, aggregate D1, build the blob with the shared builder, and publish it
 * to KV only if it clears the content floor.
 *
 * Returns a summary and never throws -- see the module header on why this lane
 * is tolerant rather than loud.
 */
export async function refreshLiveEconomics(
  env: Env,
  deps: LiveEconomicsRefreshDeps = {},
): Promise<LiveEconomicsRefreshResult> {
  if (typeof deps.readArtifact !== "function") {
    return { ok: false, reason: "reader_unavailable" };
  }
  const kv = env.METAGRAPH_CONTROL as unknown as KvLike | undefined;
  if (!kv?.put) return { ok: false, reason: "kv_binding_missing" };
  const db = env.METAGRAPH_HEALTH_DB as unknown as D1Like | undefined;
  if (!db?.prepare) return { ok: false, reason: "d1_binding_missing" };

  const now = deps.now ?? Date.now;
  try {
    const read = await deps.readArtifact(
      env,
      LIVE_ECONOMICS_SUBNETS_ARTIFACT_PATH,
    );
    if (!read.ok) return { ok: false, reason: "subnets_artifact_unavailable" };
    const index = (read.data ?? {}) as { subnets?: unknown; network?: unknown };
    const subnets = (Array.isArray(index.subnets) ? index.subnets : []).filter(
      (row: Row) => Number.isInteger(row?.netuid),
    ) as Row[];
    if (subnets.length === 0) {
      // An index with no usable rows is a broken input, not an empty network.
      // Publishing from it would write an empty blob over a good KV value.
      return { ok: false, reason: "no_subnets_in_index" };
    }
    const netuids = subnets.map((row) => row.netuid as number);

    const storage = createSubtensorPinnedStorage({
      rpcUrl:
        env.LIVE_ECONOMICS_RPC_URL ||
        env.CHAIN_HEAD_RPC_URL ||
        LIVE_ECONOMICS_DEFAULT_RPC_URL,
      fetchImpl: deps.fetchImpl,
      timeoutMs: deps.timeoutMs,
    });
    const { blockNumber, blockHash } = await storage.pinHead();

    // `block` is the instant ECONOMICS_FIELD_SOURCES calls `read_at: "capture"`
    // -- the height the row's values were read at. On this lane that is the
    // block we just pinned: every one of the thirteen fields below comes from a
    // storage map read at `blockHash`, and there is no bulk call at a second
    // height the way the retired SDK path had.
    //
    // The index's own `block` is NOT that. It is the last registry publish's
    // bulk-call height, so it drifts a full publish cycle behind this sweep --
    // measured 2026-08-03 on the live tier, the served row carried block
    // 8755515 against a chain_state.block of 8762721, 7206 blocks (~24h) of
    // skew. Inheriting it stamps every row with a height none of its values
    // were read at, which is worse than no height because it looks like
    // provenance.
    const pinnedSubnets = subnets.map((row) => ({
      ...row,
      block: blockNumber,
    }));

    const maps = {} as StorageMaps;
    for (const [name, hash] of Object.entries(ECONOMICS_STORAGE_MAPS)) {
      maps[name as MapName] = await storage.readNetuidMap(
        hash,
        blockHash,
        netuids,
      );
    }
    const values: Record<string, string | null> = {};
    for (const [name, hash] of Object.entries(ECONOMICS_STORAGE_VALUES)) {
      values[name] = await storage.readValue(hash, blockHash);
    }

    const neuronRows = await db.prepare(NEURON_AGGREGATE_QUERY).all();
    const neurons = indexNeuronAggregates(neuronRows?.results);
    const historyRows = await db.prepare(alphaPriceHistoryQuery()).all();
    const priceHistoryByNetuid = indexAlphaPriceHistoryByNetuid(
      historyRows?.results,
    );

    const economicsByNetuid = new Map<number, Row>();
    for (const netuid of netuids) {
      if (!subnetHasChainData(netuid, maps)) continue;
      economicsByNetuid.set(
        netuid,
        buildSubnetEconomics(netuid, maps, neurons.get(netuid)),
      );
    }

    const stampedAt = new Date(now()).toISOString();
    const totalIssuance = decodeLeU64(values.total_issuance);
    const gateBar = decodeLeU128(values.emission_gate_bar);
    const quantile = decodeLeU128(values.emission_bar_quantile);
    const exponent = decodeLeU128(values.emission_gate_exponent);
    const economics = buildEconomicsArtifact({
      subnets: pinnedSubnets,
      economicsByNetuid,
      generatedAt: stampedAt,
      network: typeof index.network === "string" ? index.network : null,
      capturedAt: stampedAt,
      priceHistoryByNetuid,
      // ABSENT, not partial, when issuance could not be read. Every share in
      // the decomposition is checked against the issuance-derived block
      // emission, so a chain_state without it is a block number that looks
      // like provenance and proves nothing -- and the builder omits the key
      // entirely on null, which is the shape ChainStateSchema documents for a
      // degraded run.
      chainState:
        totalIssuance === null
          ? null
          : {
              block: blockNumber,
              block_hash: blockHash,
              total_issuance_tao: raoToTao(totalIssuance),
              emission_gate_bar:
                gateBar === null ? null : u64f64U128ToFloat(gateBar),
              emission_bar_quantile:
                quantile === null ? null : u64f64U128ToFloat(quantile),
              // UNSET IS NOT ZERO. Absent means the runtime default h = 3
              // applies (buildEmissionDecomposition resolves the null itself),
              // while h = 0 would make the Hill gate a constant 0.5 for every
              // subnet. Decoded at U64F64 -- the width
              // src/emission-drift-check.ts reads this same item at -- so a
              // set exponent arrives as the small integer the decomposition
              // expects rather than as its raw 128-bit word.
              emission_gate_exponent:
                exponent === null ? null : u64f64U128ToFloat(exponent),
            },
    });
    // Match build-artifacts + refresh-economics: resolveLiveEconomics rejects
    // an off-contract blob (-> R2 fallback), so the stamp is not optional.
    economics.contract_version = CONTRACT_VERSION;

    // buildEconomicsArtifact always emits a summary carrying this count, so it
    // is read directly rather than through an `?? 0` that could never fire.
    const withEconomicsCount = (
      economics.summary as { with_economics_count: number }
    ).with_economics_count;
    const floor = shouldPublishEconomics(
      {
        with_economics_count: withEconomicsCount,
        captured_at: economics.captured_at,
      },
      subnets.length,
    );
    if (!floor.publish) {
      // The content floor, shared verbatim with the script fallback: never
      // overwrite a good live value with an empty / near-empty blob.
      return {
        ok: false,
        written: false,
        reason: `content_floor:${floor.reason}`,
        block: blockNumber,
        subnet_count: subnets.length,
        with_economics_count: withEconomicsCount,
      };
    }

    await kv.put(KV_ECONOMICS_CURRENT, JSON.stringify(economics));
    return {
      ok: true,
      written: true,
      block: blockNumber,
      subnet_count: subnets.length,
      with_economics_count: withEconomicsCount,
      captured_at: stampedAt,
    };
  } catch (error) {
    // One failed tick is one stale window, never an overwrite: the KV value
    // and the R2 fallback both survive untouched. handleScheduled records the
    // ok:false cron outcome, so this is contained without being silent.
    console.error(
      "[live-economics-refresh]",
      error instanceof Error ? error.message : String(error),
    );
    return { ok: false, written: false, reason: "unreachable" };
  }
}
