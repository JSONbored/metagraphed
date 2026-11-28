// The emission split serving builders (MET-7365) -- shared by the REST
// handlers, the GraphQL resolvers and the MCP tools, so the surfaces cannot
// drift. Pure + exported for tests; the loaders resolve the store (the native
// seam in subnet-emission-store.ts) and hand the rows in.
//
// A SPLIT IS THE CHAIN'S, READ WHOLE. Each slot is published twice: as the
// fraction of the subnet's emission it is (rounded to nine places, for
// reading) and as the runtime's exact u64 parts of u64::MAX (for anything
// that must reconcile). The five slots and the gamma shares sum to exactly
// u64::MAX, so the fractions sum to one to within the rounding.
//
// THE DECLINE IS NULL. With no store bound or no capture observed,
// `observed_block` is null and there is no split: the default 18/41/41 is not
// served in a store's absence, because a subnet's split is what the chain
// says and not what the runtime would assume.
import { round9 } from "./lib/rao.ts";
import {
  defaultEmissionSlots,
  EMISSION_PARTS_ONE,
  type EmissionSlots,
} from "./subnet-emission-capture.ts";
import {
  selectedSubnetEmissionStore,
  type SubnetEmissionCurrent,
  type SubnetEmissionHistory,
  type SubnetEmissionObservation,
} from "./subnet-emission-store.ts";

type Row = Record<string, unknown>;

const SLOTS = ["burn", "recycle", "owner", "validator", "miner"] as const;

function partsOrNull(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value))
    return null;
  const parts = BigInt(value);
  return parts <= EMISSION_PARTS_ONE ? parts : null;
}

function blockOrNull(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** A fraction of the subnet's emission, for reading. */
function share(parts: bigint): number {
  return round9(Number(parts) / Number(EMISSION_PARTS_ONE));
}

function slotsOf(row: Row): EmissionSlots | null {
  const out: Partial<EmissionSlots> = {};
  for (const slot of SLOTS) {
    const parts = partsOrNull(row[`${slot}_parts`]);
    if (parts === null) return null;
    out[slot] = parts;
  }
  return out as EmissionSlots;
}

function gammaSharesOf(
  value: unknown,
): { target_netuid: number; share: number; parts: string }[] | null {
  if (!Array.isArray(value)) return null;
  const out: { target_netuid: number; share: number; parts: string }[] = [];
  for (const entry of value) {
    const target = (entry as { target?: unknown } | null)?.target;
    const parts = partsOrNull((entry as { parts?: unknown } | null)?.parts);
    if (
      typeof target !== "number" ||
      !Number.isInteger(target) ||
      target < 0 ||
      target > 65535 ||
      parts === null
    )
      return null;
    out.push({
      target_netuid: target,
      share: share(parts),
      parts: parts.toString(),
    });
  }
  return out;
}

const DEFAULT = defaultEmissionSlots();

function isDefault(
  slots: EmissionSlots,
  gammaShares: readonly unknown[],
): boolean {
  return (
    gammaShares.length === 0 &&
    SLOTS.every((slot) => slots[slot] === DEFAULT[slot])
  );
}

/** The five slots as fractions, with their exact parts beside them. */
function slotFields(slots: EmissionSlots): Row {
  return {
    ...Object.fromEntries(SLOTS.map((slot) => [slot, share(slots[slot])])),
    parts: Object.fromEntries(
      SLOTS.map((slot) => [slot, slots[slot].toString()]),
    ),
  };
}

/** One split row as served, or null when the row does not read whole: a
 * split with a slot missing is not a split, and is never served as one. */
function formatSplit(row: Row): Row | null {
  const validFrom = blockOrNull(row.valid_from);
  const slots = slotsOf(row);
  const gammaShares = gammaSharesOf(row.gamma_shares);
  if (validFrom === null || slots === null || gammaShares === null) return null;
  return {
    valid_from: validFrom,
    valid_to: blockOrNull(row.valid_to),
    ...slotFields(slots),
    gamma_shares: gammaShares,
    is_default: isDefault(slots, gammaShares),
  };
}

function formatLifecycle(row: Row): Row | null {
  const validFrom = blockOrNull(row.valid_from);
  if (
    validFrom === null ||
    typeof row.stage !== "string" ||
    typeof row.epoch_consensus !== "string" ||
    typeof row.created_via_lease !== "boolean"
  )
    return null;
  return {
    valid_from: validFrom,
    valid_to: blockOrNull(row.valid_to),
    stage: row.stage,
    epoch_consensus: row.epoch_consensus,
    created_via_lease: row.created_via_lease,
  };
}

function observationFields(observation: SubnetEmissionObservation | null): Row {
  const block = blockOrNull(observation?.block_number);
  const ms = blockOrNull(observation?.observed_at_ms);
  return {
    observed_block: block,
    observed_at:
      block === null || ms === null ? null : new Date(ms).toISOString(),
  };
}

const formatted = <T>(rows: readonly Row[], format: (row: Row) => T | null) =>
  rows.map(format).filter((row): row is T => row !== null);

/** No rows: what a store without an observation to date its rows serves. */
const NONE = Object.freeze({ splits: [], lifecycle: [] });

export function buildSubnetEmissionSplit(
  history: SubnetEmissionHistory | null,
  netuid: unknown,
): Row {
  const observed = observationFields(history?.observation ?? null);
  // Rows are served only with the observation that dates them.
  const held = history && observed.observed_block !== null ? history : NONE;
  const splits = formatted(held.splits, formatSplit);
  const states = formatted(held.lifecycle, formatLifecycle);
  const lifecycle = states.find((row) => row.valid_to === null) ?? null;
  return {
    schema_version: 1,
    netuid,
    ...observed,
    // Whether the chain held this subnet at the observed block: a subnet
    // with no current lifecycle row was dissolved, or never registered.
    exists: observed.observed_block === null ? null : lifecycle !== null,
    lifecycle,
    split: splits.find((row) => row.valid_to === null) ?? null,
    history: splits,
    lifecycle_history: states,
  };
}

export function buildChainEmissionSplits(
  current: SubnetEmissionCurrent | null,
): Row {
  const observed = observationFields(current?.observation ?? null);
  // Rows are served only with the observation that dates them.
  const held = current && observed.observed_block !== null ? current : NONE;
  const lifecycle = new Map<number, Row>();
  for (const row of held.lifecycle) {
    const state = formatLifecycle(row);
    if (state !== null) lifecycle.set(Number(row.netuid), state);
  }
  const subnets = held.splits
    .map((row) => {
      const split = formatSplit(row);
      const state = lifecycle.get(Number(row.netuid));
      // Only a subnet the chain holds is in the set: a split row that
      // outlived its subnet is history, served per subnet.
      if (split === null || state === undefined) return null;
      return {
        netuid: Number(row.netuid),
        stage: state.stage,
        epoch_consensus: state.epoch_consensus,
        created_via_lease: state.created_via_lease,
        ...split,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);
  const count = (keep: (row: Row) => boolean) =>
    observed.observed_block === null ? null : subnets.filter(keep).length;
  return {
    schema_version: 1,
    ...observed,
    subnet_count: observed.observed_block === null ? null : subnets.length,
    custom_count: count((row) => row.is_default === false),
    gamma_share_count: count(
      (row) => (row.gamma_shares as unknown[]).length > 0,
    ),
    default_split: slotFields(DEFAULT),
    subnets,
  };
}

/**
 * One subnet's split and lifecycle through the native seam, or null.
 *
 * Null for "no store bound" AND for a store read that failed -- both render
 * as the same schema-stable decline, because a caller cannot act differently
 * on the two and an error body would turn a degraded tier into a hard failure
 * the sibling subnet routes never have.
 */
export async function loadSubnetEmissionSplit(
  env: unknown,
  netuid: number,
): Promise<SubnetEmissionHistory | null> {
  const store = selectedSubnetEmissionStore(env);
  if (!store) return null;
  try {
    return await store.subnet(netuid);
  } catch (error) {
    console.error("subnet emission store read failed:", error);
    return null;
  }
}

/** Every subnet's current split and lifecycle, or null (see above). */
export async function loadChainEmissionSplits(
  env: unknown,
): Promise<SubnetEmissionCurrent | null> {
  const store = selectedSubnetEmissionStore(env);
  if (!store) return null;
  try {
    return await store.current();
  } catch (error) {
    console.error("subnet emission store read failed:", error);
    return null;
  }
}
