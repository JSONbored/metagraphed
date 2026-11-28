// Each subnet's emission split and lifecycle state, captured from chain
// storage (runtime spec 497; MET-7365, ADR 0029 phase 2).
//
// The split says where a subnet's emission goes. v497 stores it per subnet
// (opentensor/subtensor pallets/subtensor/src/subnets/emission_weights.rs):
// five fixed slots `[burn, recycle, owner, validator, miner]` and up to
// sixteen gamma shares, each `(target netuid, parts)` converted every epoch
// into the target subnet's gamma for the owner hotkey. Every slot and share
// is u64 parts of u64::MAX, and together they sum to exactly u64::MAX. Before
// v497 the owner's cut was the runtime's fixed 18% (InitialSubnetOwnerCut,
// 11796/65535) and every reader assumed it; at block 9,602,049, 34 of 129
// mainnet subnets carried another split and six routed shares to gamma.
//
//   SubnetState            Identity(NetUid) -> SubnetLifecycleState
//                            OptionQuery: absent is no subnet
//   SubnetEmissionWeights  Identity(NetUid) -> BoundedVec<u64, 5>
//                            ValueQuery: absent is the default split
//   SubnetGammaEmission    Identity(NetUid) -> BoundedVec<(NetUid, u64), 16>
//                            ValueQuery: absent is no shares
//   SubnetEpochConsensus   Identity(NetUid) -> EpochConsensus { Yuma, Null }
//                            ValueQuery: absent is Yuma
//   SubnetCreatedViaLease  Identity(NetUid) -> bool
//                            ValueQuery: absent is false
//
// One finalized block is read whole, and the state tables keep validity
// ranges (migration 0060): a row opens at the block a capture first observed
// its values and closes at the block one observed others.

import { chainRpc } from "./chain-rpc.ts";
import {
  type ChainNetworkId,
  DEFAULT_CHAIN_NETWORK,
  rpcUrlForNetwork,
} from "./chain-network.ts";
import { bytesToHex, storageMapPrefix } from "./twox-storage-key.ts";
import {
  decode,
  decoded,
  enumerate,
  finalizedAt,
  netuidAt,
  netuidSuffix,
  RPC_TIMEOUT_MS,
  type Rpc,
  storageAt,
} from "./chain-storage-read.ts";

/** The relations one capture writes, in one transaction. */
export const SUBNET_EMISSION_CAPTURE_TABLES = Object.freeze([
  "subnet_emission_splits",
  "subnet_lifecycle_states",
  "observations",
] as const);

/** u64::MAX: the whole of a subnet's emission, in the runtime's parts. */
export const EMISSION_PARTS_ONE = (1n << 64n) - 1n;
/** The runtime's InitialSubnetOwnerCut (runtime/src/lib.rs, 18%), the owner
 * slot of every subnet that never set a split. */
const INITIAL_SUBNET_OWNER_CUT = 11_796n;
const MAX_EMISSION_SLOTS = 5;
const MAX_GAMMA_SHARES = 16;

export const SUBNET_STAGES = Object.freeze([
  "registered",
  "started",
  "pending_dissolution",
  "dissolving",
] as const);
export type SubnetStage = (typeof SUBNET_STAGES)[number];
export const EPOCH_CONSENSUS_MODES = Object.freeze(["yuma", "null"] as const);
export type EpochConsensus = (typeof EPOCH_CONSENSUS_MODES)[number];

/** The five fixed slots, in u64 parts. */
export interface EmissionSlots {
  burn: bigint;
  recycle: bigint;
  owner: bigint;
  validator: bigint;
  miner: bigint;
}

export interface GammaShare {
  target: number;
  parts: bigint;
}

const prefix = (item: string) =>
  bytesToHex(storageMapPrefix("SubtensorModule", item));
const KEY = Object.freeze({
  state: prefix("SubnetState"),
  weights: prefix("SubnetEmissionWeights"),
  gamma: prefix("SubnetGammaEmission"),
  consensus: prefix("SubnetEpochConsensus"),
  lease: prefix("SubnetCreatedViaLease"),
});

/** The split of a subnet that never set one, as the runtime builds it
 * (`default_emission_weights`): the owner slot is InitialSubnetOwnerCut
 * scaled from u16 parts, validators take half of the rest, and the miner
 * slot absorbs the rounding so the five sum to exactly u64::MAX. */
export function defaultEmissionSlots(): EmissionSlots {
  const owner = (INITIAL_SUBNET_OWNER_CUT * EMISSION_PARTS_ONE) / 65_535n;
  const validator = (EMISSION_PARTS_ONE - owner) / 2n;
  return {
    burn: 0n,
    recycle: 0n,
    owner,
    validator,
    miner: EMISSION_PARTS_ONE - owner - validator,
  };
}

export const decodeSubnetStage = (hex: string): SubnetStage =>
  SUBNET_STAGES[decode(hex, (s) => s.variant(SUBNET_STAGES.length))];

export const decodeEpochConsensus = (hex: string): EpochConsensus =>
  EPOCH_CONSENSUS_MODES[
    decode(hex, (s) => s.variant(EPOCH_CONSENSUS_MODES.length))
  ];

export const decodeLeaseFlag = (hex: string): boolean =>
  decode(hex, (s) => s.bool());

/** SubnetEmissionWeights. The runtime reads a vector shorter than five as
 * its slots with the rest zero (`get_subnet_emission_weights`). */
export function decodeEmissionSlots(hex: string): EmissionSlots {
  const slots = decode(hex, (s) => {
    const length = s.length(MAX_EMISSION_SLOTS);
    return Array.from({ length }, () => s.uint(8));
  });
  const [burn = 0n, recycle = 0n, owner = 0n, validator = 0n, miner = 0n] =
    slots;
  return { burn, recycle, owner, validator, miner };
}

/** SubnetGammaEmission: `(target netuid, parts)` in ascending target order. */
export function decodeGammaShares(hex: string): GammaShare[] {
  return decode(hex, (s) => {
    const length = s.length(MAX_GAMMA_SHARES);
    return Array.from({ length }, () => ({
      target: Number(s.uint(2)),
      parts: s.uint(8),
    }));
  });
}

export interface SubnetEmissionState {
  netuid: number;
  stage: SubnetStage;
  epochConsensus: EpochConsensus;
  createdViaLease: boolean;
  slots: EmissionSlots;
  gammaShares: GammaShare[];
}

export interface SubnetEmissionSnapshot {
  block: number;
  /** Every subnet whose state read whole, ascending by netuid. */
  subnets: SubnetEmissionState[];
  /** Subnets the chain holds whose state did not read whole: their rows are
   * left as they are, neither changed nor closed as gone. */
  unknown: number[];
  /** Values that did not decode, counted rather than guessed at. */
  undecoded: number;
}

/** One finalized block's emission split and lifecycle state for every
 * subnet. Throws on an RPC failure or a listing past its bound, since a
 * partial listing of SubnetState cannot say which subnets are gone; the
 * capture turns a throw into a reason. */
export async function loadSubnetEmissionSnapshot(
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
  rpc: Rpc = (method, params) =>
    chainRpc(rpcUrlForNetwork(network), method, params, {
      timeoutMs: RPC_TIMEOUT_MS,
    }),
): Promise<SubnetEmissionSnapshot> {
  const { at, block } = await finalizedAt(rpc);
  const stateKeys = await enumerate(rpc, KEY.state, at);
  if (stateKeys === null)
    throw new Error("SubnetState is larger than its read bound");
  const netuids = stateKeys
    .map((key) => {
      const suffix = key.slice(KEY.state.length);
      // A key that names no netuid cannot be told apart from a subnet that is
      // gone, and closing a live subnet's rows would be a wrong answer.
      if (!/^[0-9a-f]{4}$/.test(suffix))
        throw new Error("SubnetState holds a key that names no netuid");
      return netuidAt(suffix, 0);
    })
    .sort((a, b) => a - b);
  const items = [
    KEY.state,
    KEY.weights,
    KEY.gamma,
    KEY.consensus,
    KEY.lease,
  ] as const;
  const values = await storageAt(
    rpc,
    items.flatMap((item) => netuids.map((n) => item + netuidSuffix(n))),
    at,
  );
  const miss = { undecoded: 0 };
  const subnets: SubnetEmissionState[] = [];
  const unknown: number[] = [];
  const fallback = defaultEmissionSlots();
  for (const netuid of netuids) {
    const valueOf = (item: string) => values.get(item + netuidSuffix(netuid));
    const before = miss.undecoded;
    const stage = decoded(valueOf(KEY.state), decodeSubnetStage, miss);
    const slots = decoded(valueOf(KEY.weights), decodeEmissionSlots, miss);
    const gammaShares = decoded(valueOf(KEY.gamma), decodeGammaShares, miss);
    const consensus = decoded(
      valueOf(KEY.consensus),
      decodeEpochConsensus,
      miss,
    );
    const lease = decoded(valueOf(KEY.lease), decodeLeaseFlag, miss);
    // A listed key whose value is gone by the read is a subnet dissolved in
    // between; it is unknown at this block, like one that did not decode.
    if (stage === null || miss.undecoded > before) {
      unknown.push(netuid);
      continue;
    }
    subnets.push({
      netuid,
      stage,
      // Absent is each ValueQuery's default.
      epochConsensus: consensus ?? "yuma",
      createdViaLease: lease ?? false,
      slots: slots ?? fallback,
      gammaShares: gammaShares ?? [],
    });
  }
  return { block, subnets, unknown, undecoded: miss.undecoded };
}

/** A current split row as the store reads it: every part as decimal text. */
export type SplitRow = {
  netuid: number;
  burn_parts: string;
  recycle_parts: string;
  owner_parts: string;
  validator_parts: string;
  miner_parts: string;
  /** The jsonb array as the database returns it. */
  gamma_shares: unknown;
};

export type LifecycleRow = {
  netuid: number;
  stage: string;
  epoch_consensus: string;
  created_via_lease: boolean;
};

/** A split row to open, its parts as decimal text for the JSON recordset. */
export interface SplitOpen {
  netuid: number;
  burn_parts: string;
  recycle_parts: string;
  owner_parts: string;
  validator_parts: string;
  miner_parts: string;
  gamma_shares: { target: number; parts: string }[];
}

export interface LifecycleOpen {
  netuid: number;
  stage: SubnetStage;
  epoch_consensus: EpochConsensus;
  created_via_lease: boolean;
}

export interface SubnetEmissionChanges {
  /** Netuids whose current split row closes at the snapshot's block. */
  closeSplits: number[];
  openSplits: SplitOpen[];
  closeLifecycle: number[];
  openLifecycle: LifecycleOpen[];
}

function shareKey(shares: unknown): string | null {
  if (!Array.isArray(shares)) return null;
  const out: string[] = [];
  for (const share of shares) {
    const target = (share as { target?: unknown } | null)?.target;
    const parts = (share as { parts?: unknown } | null)?.parts;
    if (typeof target !== "number" || typeof parts !== "string") return null;
    out.push(`${target}:${parts}`);
  }
  return out.join(",");
}

/** What one snapshot changes, against the current rows. Pure: a subnet whose
 * values match its current row changes nothing, one whose values differ
 * closes its row and opens another, and a subnet the chain no longer holds
 * closes its row and opens none. */
export function subnetEmissionChanges(
  snapshot: SubnetEmissionSnapshot,
  current: { splits: readonly SplitRow[]; lifecycle: readonly LifecycleRow[] },
): SubnetEmissionChanges {
  const splits = new Map(current.splits.map((row) => [row.netuid, row]));
  const lifecycle = new Map(current.lifecycle.map((row) => [row.netuid, row]));
  const seen = new Set([
    ...snapshot.subnets.map((s) => s.netuid),
    ...snapshot.unknown,
  ]);
  const changes: SubnetEmissionChanges = {
    closeSplits: [],
    openSplits: [],
    closeLifecycle: [],
    openLifecycle: [],
  };
  for (const subnet of snapshot.subnets) {
    const open: SplitOpen = {
      netuid: subnet.netuid,
      burn_parts: subnet.slots.burn.toString(),
      recycle_parts: subnet.slots.recycle.toString(),
      owner_parts: subnet.slots.owner.toString(),
      validator_parts: subnet.slots.validator.toString(),
      miner_parts: subnet.slots.miner.toString(),
      gamma_shares: subnet.gammaShares.map((share) => ({
        target: share.target,
        parts: share.parts.toString(),
      })),
    };
    const row = splits.get(subnet.netuid);
    const same =
      row !== undefined &&
      row.burn_parts === open.burn_parts &&
      row.recycle_parts === open.recycle_parts &&
      row.owner_parts === open.owner_parts &&
      row.validator_parts === open.validator_parts &&
      row.miner_parts === open.miner_parts &&
      shareKey(row.gamma_shares) === shareKey(open.gamma_shares);
    if (!same) {
      if (row !== undefined) changes.closeSplits.push(subnet.netuid);
      changes.openSplits.push(open);
    }
    const state = lifecycle.get(subnet.netuid);
    if (
      state === undefined ||
      state.stage !== subnet.stage ||
      state.epoch_consensus !== subnet.epochConsensus ||
      state.created_via_lease !== subnet.createdViaLease
    ) {
      if (state !== undefined) changes.closeLifecycle.push(subnet.netuid);
      changes.openLifecycle.push({
        netuid: subnet.netuid,
        stage: subnet.stage,
        epoch_consensus: subnet.epochConsensus,
        created_via_lease: subnet.createdViaLease,
      });
    }
  }
  for (const netuid of splits.keys())
    if (!seen.has(netuid)) changes.closeSplits.push(netuid);
  for (const netuid of lifecycle.keys())
    if (!seen.has(netuid)) changes.closeLifecycle.push(netuid);
  return changes;
}

export interface SubnetEmissionWriteOutcome {
  /** False when the store already holds an observation at or past this
   * block: a capture never moves the state tables backwards. */
  written: boolean;
  opened: number;
  closed: number;
}

/** The writer the capture needs (src/pg-subnet-emission.ts implements it). */
export interface SubnetEmissionWriter {
  write(
    snapshot: SubnetEmissionSnapshot,
    observedAtMs: number,
  ): Promise<SubnetEmissionWriteOutcome>;
}

/**
 * Persist one capture. Never throws: a capture that could take down the cron
 * it rides would be worse than a gap. Returns what happened for the lane's
 * verdict.
 */
export async function captureSubnetEmission(
  _env: unknown,
  {
    store,
    now = Date.now,
    network,
    load = loadSubnetEmissionSnapshot,
  }: {
    store?: SubnetEmissionWriter | null;
    now?: () => number;
    network?: ChainNetworkId;
    load?: typeof loadSubnetEmissionSnapshot;
  } = {},
): Promise<{
  ok: boolean;
  subnets: number;
  changed: number;
  undecoded: number;
  reason?: string;
}> {
  const none = { subnets: 0, changed: 0, undecoded: 0 };
  if (typeof store?.write !== "function")
    return { ok: false, ...none, reason: "no_store_binding" };
  let snapshot: SubnetEmissionSnapshot;
  try {
    snapshot = await load(network);
  } catch (error) {
    return {
      ok: false,
      ...none,
      reason: `chain_read_failed: ${String((error as Error)?.message ?? error)}`,
    };
  }
  let outcome: SubnetEmissionWriteOutcome;
  try {
    outcome = await store.write(snapshot, now());
  } catch (error) {
    return {
      ok: false,
      ...none,
      undecoded: snapshot.undecoded,
      reason: `write_failed: ${String((error as Error)?.message ?? error)}`,
    };
  }
  const reason = !outcome.written
    ? "not_newer"
    : snapshot.undecoded > 0
      ? `undecoded: ${snapshot.undecoded}`
      : undefined;
  return {
    ok: outcome.written && snapshot.undecoded === 0,
    subnets: snapshot.subnets.length,
    changed: outcome.opened + outcome.closed,
    undecoded: snapshot.undecoded,
    ...(reason === undefined ? {} : { reason }),
  };
}
