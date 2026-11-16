// The subnet-gamma serving builders (#13164) -- shared by the REST handlers
// (/subnets/{netuid}/gamma, its /history, /chain/gamma), the GraphQL resolver
// and the MCP tool, so the surfaces cannot drift. Pure + exported for tests;
// callers resolve the store (the native seam in subnet-gamma-store.ts) and
// hand the rows in.
//
// THE DECLINE IS NULL, NEVER ZERO OR FALSE. The Gamma state's writers -- the
// engine's GammaEnabled / SubnetGammaEnabled / SubnetGammaPrice /
// SubnetGammaEmission / PendingGammaEmission / UnconvertedGammaEmission /
// SubnetGammaEmissionWhitelisted decode -- land separately (#13164 defers
// them), so an empty table is not "Gamma is off here": it is "the Gamma
// capture has not run", and `gamma: null` / `point_count: null` /
// `subnet_count: null` is how the artifacts say so. Emission quantities are
// u64 atomic units as decimal strings; price crosses verbatim as the chain's
// raw encoding in decimal text, because re-scaling it here would invent
// precision the decode owns.
import { selectedSubnetGammaStore } from "./subnet-gamma-store.ts";
import { u64TextOrNull } from "./subnet-alpha-dividends.ts";

type Row = Record<string, unknown>;

const U128_MAX = 340282366920938463463374607431768211455n;

function toIso(ms: unknown): string | null {
  if (ms == null) return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** A u128 quantity as canonical decimal text; anything else is null. */
export function u128TextOrNull(value: unknown): string | null {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
    return null;
  return BigInt(value) <= U128_MAX ? value : null;
}

/** A stored boolean, or null -- a cell that is not literally true/false is
 * "not carried", never coalesced to false (which would claim a measured
 * off-switch). */
export function boolOrNull(value: unknown): boolean | null {
  return value === true || value === false ? value : null;
}

function nonNegativeInt(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** One stored capture row to the published per-subnet Gamma state. */
export function formatGammaState(row: Row): Row {
  return {
    enabled: boolOrNull(row?.enabled),
    price: u128TextOrNull(row?.price),
    emission: u64TextOrNull(row?.emission),
    pending_emission: u64TextOrNull(row?.pending_emission),
    unconverted_emission: u64TextOrNull(row?.unconverted_emission),
    whitelisted: boolOrNull(row?.whitelisted),
    captured_at: toIso(row?.captured_at),
  };
}

export function buildSubnetGamma(
  rows: readonly Row[] | null,
  netuid: unknown,
): Row {
  const row = rows?.[0];
  const gamma = row === undefined ? null : formatGammaState(row);
  return {
    schema_version: 1,
    netuid,
    gamma,
    captured_at: gamma === null ? null : (gamma.captured_at as string | null),
  };
}

export function buildSubnetGammaHistory(
  rows: readonly Row[] | null,
  netuid: unknown,
): Row {
  const points = (rows ?? []).map((row) => formatGammaState(row));
  // Newest stamp across the points: the store reads newest-first, but a
  // stored stamp can be unusable, so the summary is measured rather than
  // assumed from position 0.
  let newest: string | null = null;
  for (const point of points) {
    const stamp = point.captured_at as string | null;
    if (stamp !== null && (newest === null || stamp > newest)) newest = stamp;
  }
  return {
    schema_version: 1,
    netuid,
    point_count: points.length > 0 ? points.length : null,
    captured_at: newest,
    points,
  };
}

export function buildChainGamma(
  loaded: { subnets: Row[]; enabled: Row | null } | null,
): Row {
  if (loaded === null) {
    return {
      schema_version: 1,
      enabled: null,
      enabled_captured_at: null,
      subnet_count: null,
      captured_at: null,
      subnets: [],
    };
  }
  const subnets: Row[] = [];
  for (const row of loaded.subnets) {
    const netuid = nonNegativeInt(row?.netuid);
    // A row without a subnet identity names nothing; drop it rather than
    // serve a state that cannot be attributed.
    if (netuid === null || netuid > 65535) continue;
    subnets.push({ netuid, ...formatGammaState(row) });
  }
  const enabled =
    loaded.enabled === null ? null : boolOrNull(loaded.enabled.enabled);
  const enabledStamp =
    loaded.enabled === null ? null : toIso(loaded.enabled.captured_at);
  let newest: string | null = enabledStamp;
  for (const subnet of subnets) {
    const stamp = subnet.captured_at as string | null;
    if (stamp !== null && (newest === null || stamp > newest)) newest = stamp;
  }
  return {
    schema_version: 1,
    enabled,
    enabled_captured_at: enabledStamp,
    subnet_count: subnets.length > 0 ? subnets.length : null,
    captured_at: newest,
    subnets,
  };
}

/**
 * One subnet's newest Gamma capture through the native seam, or null.
 *
 * Null for "no store bound" (today's deployed Workers) AND for a store read
 * that failed -- both render as the same schema-stable decline, because a
 * caller cannot act differently on the two and an error body would turn a
 * degraded tier into a hard failure the sibling subnet routes never have.
 */
export async function loadSubnetGamma(
  env: unknown,
  netuid: number,
): Promise<Row[] | null> {
  const store = selectedSubnetGammaStore(env);
  if (!store) return null;
  try {
    return await store.latest(netuid);
  } catch (error) {
    console.error("subnet gamma store read failed:", error);
    return null;
  }
}

/** One subnet's Gamma capture series -- same decline rules as
 * loadSubnetGamma. */
export async function loadSubnetGammaHistory(
  env: unknown,
  netuid: number,
): Promise<Row[] | null> {
  const store = selectedSubnetGammaStore(env);
  if (!store) return null;
  try {
    return await store.history(netuid);
  } catch (error) {
    console.error("subnet gamma store read failed:", error);
    return null;
  }
}

/** The chain-wide Gamma state -- same decline rules as loadSubnetGamma. The
 * two reads are SEQUENTIAL, deliberately: each read through this seam is its
 * own admission-controlled transaction, so firing both at once can hit the
 * runtime's connection ceiling and turn a healthy store into a decline. */
export async function loadChainGamma(
  env: unknown,
): Promise<{ subnets: Row[]; enabled: Row | null } | null> {
  const store = selectedSubnetGammaStore(env);
  if (!store) return null;
  try {
    const subnets = await store.chain();
    const enabled = (await store.enabled())[0] ?? null;
    return { subnets, enabled };
  } catch (error) {
    console.error("subnet gamma store read failed:", error);
    return null;
  }
}
