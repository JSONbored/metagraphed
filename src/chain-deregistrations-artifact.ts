// The three deregistration scopes, served from a scheduled projection over
// UID reuse in the NeuronRegistered stream (#9307).
//
// WHY A PROJECTION, NOT A REQUEST-TIME READ. The derivation needs the RAW
// registration rows -- slot, holder, order -- not an aggregate, because "who
// held this slot before" is a sequence question no GROUP BY answers. Measured
// live (2026-08-03) that read costs 693 MB scanned / ~5s for 30 days, which is
// the same order as the chain-registrations lane's own 508 MB and firmly in
// "once per tick, never per request" territory (src/r2-sql.ts's measured
// characteristics; src/projection-lanes.ts's header).
//
// ONE PULL, EVERY SCOPE. The lane pulls the WIDEST window once and slices the
// narrower ones out of it, which is both cheaper and more accurate: deriving
// the 7d window from a 30d pull gives it 23 days of prior occupancy, and that
// is what takes its unattributed share from 66% down to 21% (see
// src/deregistration-derivation.ts's measurement table). The per-subnet rows
// the chain leaderboard ranks are the same rows the per-subnet route reads,
// and the per-hotkey index is the same events keyed by the DISPLACED holder,
// so all three scopes are one derivation rather than three that can disagree.
//
// TWO OBJECTS, ON PURPOSE. The rollup body is ~8 KB; the per-hotkey index is
// ~1.5 MB (12,392 displaced hotkeys over 30d). Splitting them means the chain
// and subnet routes never fetch and parse 200x the bytes they read. See
// ProjectionLane.split in src/projection-lanes.ts.
//
// DECLINE, NEVER APPROXIMATE. Unbound store, missing object, unrecognized
// body, or a window the lane did not precompute all return null so the caller
// keeps its schema-stable empty -- marked, via markDeregistrationsNotDerived
// below, so that empty is never read as a measurement. Same contract as the
// sibling chain-* artifact readers.

import {
  buildChainDeregistrations,
  CHAIN_DEREGISTRATIONS_WINDOWS,
  DEFAULT_CHAIN_DEREGISTRATIONS_WINDOW,
} from "./chain-deregistrations.ts";
import {
  type ChainNetworkId,
  DEFAULT_CHAIN_NETWORK,
  projectionKey,
} from "./chain-network.ts";
import {
  buildSubnetDeregistrations,
  SUBNET_DEREGISTRATIONS_WINDOWS,
  DEFAULT_SUBNET_DEREGISTRATIONS_WINDOW,
} from "./subnet-deregistrations.ts";
import {
  buildAccountDeregistrations,
  DEREGISTRATION_WINDOWS as ACCOUNT_DEREGISTRATION_WINDOWS,
  DEFAULT_DEREGISTRATION_WINDOW as DEFAULT_ACCOUNT_DEREGISTRATION_WINDOW,
} from "./account-deregistrations.ts";
import {
  deregistrationRowsForHotkey,
  type DeregistrationDerivation,
} from "./deregistration-derivation.ts";
import { DEREGISTRATIONS_DEGRADED_NOT_DERIVED } from "./uncurated-event-streams.ts";

/** The rollup body: per-subnet rows + the network rollup, ~8 KB. */
export const CHAIN_DEREGISTRATIONS_PROJECTION_KEY =
  "metagraph/projections/chain-deregistrations.json";

/** The per-displaced-hotkey index, ~1.5 MB — read only by the account scope. */
export const CHAIN_DEREGISTRATIONS_HOTKEY_PROJECTION_KEY =
  "metagraph/projections/chain-deregistrations-by-hotkey.json";

interface ArtifactBucket {
  get(key: string): Promise<{ json(): Promise<unknown> } | null>;
}

interface ProjectionWindow {
  network?: unknown;
  rows?: unknown;
  hotkeys?: unknown;
  derivation?: unknown;
}

/**
 * Attach the "this zero is not a measurement" marker to a schema-stable empty
 * the derivation could not answer.
 *
 * Mutates and returns the payload rather than spreading it: every caller has
 * just built it, nothing else holds a reference, and a spread would drop the
 * builders' exact key order out of the response for no gain.
 */
export function markDeregistrationsNotDerived<T extends object>(payload: T): T {
  (payload as { degraded?: { reason: string } }).degraded = {
    reason: DEREGISTRATIONS_DEGRADED_NOT_DERIVED,
  };
  return payload;
}

/** Fetch + shape-check one projection object, or null on any decline. */
async function readProjection(
  env: Env | null | undefined,
  key: string,
  network: ChainNetworkId,
): Promise<Record<string, ProjectionWindow> | null> {
  const bucket = (env as { METAGRAPH_ARCHIVE?: ArtifactBucket } | null)
    ?.METAGRAPH_ARCHIVE;
  if (!bucket?.get) return null;
  try {
    const object = await bucket.get(projectionKey(key, network));
    if (!object) return null;
    const body = (await object.json()) as {
      schema_version?: unknown;
      windows?: unknown;
    } | null;
    // A body that is not the artifact the lane wrote is a decline, not a
    // guess -- same contract as the sibling chain-* readers.
    if (
      body?.schema_version !== 1 ||
      typeof body.windows !== "object" ||
      body.windows === null
    ) {
      return null;
    }
    return body.windows as Record<string, ProjectionWindow>;
  } catch {
    return null;
  }
}

/**
 * The window this request asked for, or null when the route does not offer it
 * or the lane did not precompute it.
 *
 * A window outside the route's own set, or one this artifact does not carry,
 * must NEVER be answered with a different window's numbers -- the account
 * scope offers 90d and the lane derives 7d/30d, so that fall-through is a
 * live case here, not a defensive one.
 */
function selectWindow(
  windows: Record<string, ProjectionWindow> | null,
  routeWindows: Record<string, number>,
  fallbackLabel: string,
  requested: string | null | undefined,
): { label: string; window: ProjectionWindow } | null {
  if (windows === null) return null;
  const label = requested ?? fallbackLabel;
  if (!Object.hasOwn(routeWindows, label)) return null;
  const window = windows[label];
  if (!window || typeof window !== "object") return null;
  return { label, window };
}

/** The derivation echo the lane stored, or null when the body predates it. */
function derivationOf(
  window: ProjectionWindow,
): DeregistrationDerivation | null {
  const derivation = window.derivation as DeregistrationDerivation | undefined;
  return derivation && typeof derivation === "object" ? derivation : null;
}

/**
 * GET /api/v1/chain/deregistrations — the network-wide leaderboard.
 *
 * The network rollup is handed through as the lane computed it, never summed
 * from the per-subnet rows: one hotkey evicted from three subnets is three
 * subnet-level hotkeys but ONE network-wide distinct hotkey.
 */
export async function loadChainDeregistrationsFromArtifact(
  env: Env | null | undefined,
  query: { window?: string | null; limit?: number },
  /** Which chain's projection to read (#9412). */
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<ReturnType<typeof buildChainDeregistrations> | null> {
  const selected = selectWindow(
    await readProjection(env, CHAIN_DEREGISTRATIONS_PROJECTION_KEY, network),
    CHAIN_DEREGISTRATIONS_WINDOWS,
    DEFAULT_CHAIN_DEREGISTRATIONS_WINDOW,
    query.window,
  );
  if (selected === null) return null;
  const rows = selected.window.rows;
  if (!Array.isArray(rows)) return null;
  const data = buildChainDeregistrations(rows as Record<string, unknown>[], {
    window: selected.label,
    limit: query.limit,
    networkDistinct:
      (selected.window.network as {
        distinct_deregistered_hotkeys?: unknown;
        newest_observed?: unknown;
      } | null) ?? undefined,
  });
  const derivation = derivationOf(selected.window);
  if (derivation) data.derivation = derivation;
  return data;
}

/**
 * GET /api/v1/subnets/{netuid}/deregistrations — one subnet's card, read out
 * of the SAME per-subnet rows the chain leaderboard ranks.
 *
 * A netuid absent from those rows is a real zero, not a miss: the lane derives
 * every subnet in the window, so "no row" means "no slot on this subnet
 * changed hands". That is why this returns a zeroed card rather than null in
 * that case -- declining would mark a measured quiet as an unanswerable one.
 */
export async function loadSubnetDeregistrationsFromArtifact(
  env: Env | null | undefined,
  netuid: unknown,
  query: { window?: string | null } = {},
  /** Which chain's projection to read (#9412). */
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<Record<string, unknown> | null> {
  const selected = selectWindow(
    await readProjection(env, CHAIN_DEREGISTRATIONS_PROJECTION_KEY, network),
    SUBNET_DEREGISTRATIONS_WINDOWS,
    DEFAULT_SUBNET_DEREGISTRATIONS_WINDOW,
    query.window,
  );
  if (selected === null) return null;
  const rows = selected.window.rows;
  if (!Array.isArray(rows)) return null;
  const target = Number(netuid);
  const row =
    (rows as Record<string, unknown>[]).find(
      (candidate) => Number(candidate?.netuid) === target,
    ) ?? null;
  const data = buildSubnetDeregistrations(row, netuid, {
    window: selected.label,
  });
  const derivation = derivationOf(selected.window);
  if (derivation) data.derivation = derivation;
  return data;
}

/**
 * GET /api/v1/accounts/{ss58}/deregistrations — the slots where this hotkey
 * was the PREVIOUS holder.
 *
 * Reads the split-out per-hotkey object, not the rollup one: see this module's
 * header for why they are separate. An address absent from the index is a real
 * zero for the same reason a netuid absent above is.
 */
export async function loadAccountDeregistrationsFromArtifact(
  env: Env | null | undefined,
  ss58: string,
  query: { window?: string | null } = {},
  /** Which chain's projection to read (#9412). */
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<{
  data: ReturnType<typeof buildAccountDeregistrations>;
  generatedAt: string | null;
} | null> {
  const selected = selectWindow(
    await readProjection(
      env,
      CHAIN_DEREGISTRATIONS_HOTKEY_PROJECTION_KEY,
      network,
    ),
    ACCOUNT_DEREGISTRATION_WINDOWS,
    DEFAULT_ACCOUNT_DEREGISTRATION_WINDOW,
    query.window,
  );
  if (selected === null) return null;
  const index = selected.window.hotkeys;
  if (typeof index !== "object" || index === null) return null;
  const rows = deregistrationRowsForHotkey(
    (index as Record<string, unknown>)[ss58],
  );
  const data = buildAccountDeregistrations(rows, ss58, {
    window: selected.label,
  });
  const derivation = derivationOf(selected.window);
  if (derivation) data.derivation = derivation;
  let newest: number | null = null;
  for (const row of rows) {
    const last = Number(row.last_observed);
    if (Number.isFinite(last) && (newest === null || last > newest)) {
      newest = last;
    }
  }
  return {
    data,
    generatedAt: newest === null ? null : new Date(newest).toISOString(),
  };
}
