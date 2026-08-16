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

import { z } from "zod";

import {
  buildChainDeregistrations,
  CHAIN_DEREGISTRATIONS_WINDOWS,
  DEFAULT_CHAIN_DEREGISTRATIONS_WINDOW,
} from "./chain-deregistrations.ts";
import { type ChainNetworkId, DEFAULT_CHAIN_NETWORK } from "./chain-network.ts";
import { readArtifactObject } from "./projection-store.ts";
import {
  ProjectionAggregateSchema,
  ProjectionRowsSchema,
} from "../schemas-src/projection-artifact.ts";
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
// The SAME schema the route publishes, not a second copy of it. It is
// `.strict()` with `z.int().min(0)` bounds, so the read now proves the stored
// derivation is exactly what callers are promised -- and `is_lower_bound`, the
// field that says the count is a FLOOR rather than a measurement, can no
// longer be absent and read as false (#9708).
import { DeregistrationDerivationSchema } from "../schemas-src/routes/event-stream-honesty.ts";
import { DEREGISTRATIONS_DEGRADED_NOT_DERIVED } from "./uncurated-event-streams.ts";

/** The rollup body: per-subnet rows + the network rollup, ~8 KB. */
export const CHAIN_DEREGISTRATIONS_PROJECTION_KEY =
  "metagraph/projections/chain-deregistrations.json";

/** The per-displaced-hotkey index, ~1.5 MB — read only by the account scope. */
export const CHAIN_DEREGISTRATIONS_HOTKEY_PROJECTION_KEY =
  "metagraph/projections/chain-deregistrations-by-hotkey.json";

/**
 * The per-(netuid, uid) eviction index (#9873) — read only by the per-subnet
 * scope.
 *
 * Widest window only: every tuple carries its own `observed_at`, so a narrower
 * window is a filter rather than a second copy.
 */
export const CHAIN_DEREGISTRATIONS_UID_PROJECTION_KEY =
  "metagraph/projections/chain-deregistrations-by-uid.json";

/**
 * One window across all three scopes.
 *
 * Every field is optional because the three objects this lane writes do not
 * share a shape: the rollup carries `rows` + `network`, the per-hotkey index
 * carries `hotkeys`, and each caller requires the one it reads. Requiring all
 * of them here would decline two objects out of three on every call.
 */
const DeregistrationWindowSchema = z.object({
  network: ProjectionAggregateSchema,
  rows: ProjectionRowsSchema.optional(),
  hotkeys: z.record(z.string(), z.unknown()).optional(),
  // A derivation that does not parse degrades to ABSENT rather than failing
  // the window. That is not leniency for its own sake: "no derivation echo" is
  // a state every caller already handles (bodies predating #9708 have none),
  // whereas declining would drop an otherwise-good leaderboard over an
  // advisory block. What it must never do is default `is_lower_bound` to
  // false, which would publish a floor as a measurement.
  derivation: DeregistrationDerivationSchema.optional().catch(undefined),
});
type ProjectionWindow = z.infer<typeof DeregistrationWindowSchema>;

/**
 * The envelope, keeping unknown keys.
 *
 * `.catchall` rather than a fixed shape because the three objects diverge
 * BELOW `schema_version`: two are keyed by window, the per-uid index publishes
 * `by_netuid` instead. Pinning `windows` here would decline the uid object on
 * every call, which is the same reason the function this replaces checked only
 * `schema_version`.
 */
const DeregistrationEnvelopeSchema = z
  .object({ schema_version: z.literal(1) })
  .catchall(z.unknown());

/**
 * One eviction, exactly as `DeregistrationUidTuple` declares it.
 *
 * Parsed PER TUPLE rather than over the whole list, because the contract here
 * is drop-the-bad-row, not decline-the-subnet: a lane that emitted one short
 * or half-typed row must not cost a caller every other eviction on that
 * subnet. Publishing such a row instead would put `"observed_at": null`, or a
 * five-field row's undefined tail, into a response that claims every field is
 * present.
 */
const DeregistrationUidTupleSchema = z.tuple([
  z.number(),
  z.string(),
  z.string(),
  z.number(),
  z.number(),
  z.number().nullable(),
]);

/** The per-uid eviction index: netuid -> the tuples the subnet scope slices. */
const DeregistrationUidIndexSchema = z.object({
  by_netuid: z.record(z.string(), z.array(z.unknown())).optional(),
});

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
  const body = await readProjectionBody(env, key, network);
  if (!body) return null;
  // A body that is not the artifact the lane wrote is a decline, not a
  // guess -- same contract as the sibling chain-* readers.
  const windows = z
    .record(z.string(), DeregistrationWindowSchema)
    .safeParse(body.windows);
  return windows.success ? windows.data : null;
}

/**
 * The validated projection body, before any window unwrapping.
 *
 * The three objects this lane writes do NOT share one shape: the rollup and
 * the per-hotkey index are keyed by window, while the per-uid index publishes
 * a single widest-window list that readers slice by `observed_at` (#9873).
 * Only `schema_version` is common, so that is all this checks -- pushing the
 * `windows` requirement down here would silently decline the uid object on
 * every call.
 */
async function readProjectionBody(
  env: Env | null | undefined,
  key: string,
  network: ChainNetworkId,
): Promise<Record<string, unknown> | null> {
  return await readArtifactObject(
    env,
    key,
    network,
    DeregistrationEnvelopeSchema,
  );
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
  return window.derivation ?? null;
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
  if (!rows) return null;
  const data = buildChainDeregistrations(rows, {
    window: selected.label,
    limit: query.limit,
    networkDistinct: selected.window.network ?? undefined,
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
  // Two objects, one round trip. The counts come from the rollup the
  // leaderboard ranks (so a subnet card can never disagree with its own row);
  // the events come from the per-uid index. Neither read depends on the
  // other's result -- only the SLICE depends on which window won -- so issuing
  // them serially would buy nothing but latency (#9873).
  const [rollup, evictions] = await Promise.all([
    readProjection(env, CHAIN_DEREGISTRATIONS_PROJECTION_KEY, network),
    readProjectionBody(env, CHAIN_DEREGISTRATIONS_UID_PROJECTION_KEY, network),
  ]);
  const selected = selectWindow(
    rollup,
    SUBNET_DEREGISTRATIONS_WINDOWS,
    DEFAULT_SUBNET_DEREGISTRATIONS_WINDOW,
    query.window,
  );
  if (selected === null) return null;
  const rows = selected.window.rows;
  if (!rows) return null;
  const target = Number(netuid);
  const row =
    rows.find((candidate) => Number(candidate.netuid) === target) ?? null;
  const data = buildSubnetDeregistrations(row, netuid, {
    window: selected.label,
  });
  const derivation = derivationOf(selected.window);
  if (derivation) data.derivation = derivation;
  // selectWindow only returns a label it found in SUBNET_DEREGISTRATIONS_WINDOWS,
  // so this lookup cannot miss -- which is why the slice takes a plain number
  // and carries no "window unknown" branch to guard.
  data.events = subnetUidEvictions(
    evictions,
    target,
    SUBNET_DEREGISTRATIONS_WINDOWS[selected.label]!,
  );
  return data;
}

/**
 * The individual evictions behind this subnet's count (#9873).
 *
 * WHY THE SCALAR WAS NOT ENOUGH. An operator asking "how likely is MY uid to be
 * evicted, and how soon" cannot answer it from a subnet-wide rate. These rows
 * carry which UID turned over, when, who lost it and who took it, so a caller
 * can work out whether pruning is oldest-first, lowest-incentive-first or
 * something else, and where they sit in that ordering. That is the reporter's
 * own framing: they wanted to determine the rule, not be handed a score.
 *
 * DELIBERATELY NOT A RISK MODEL. Publishing a "pruning score" would be a model
 * presented as a measurement -- the failure `is_lower_bound` and `derivation`
 * exist to prevent (#9307).
 *
 * Sliced from the widest window: every tuple carries its own observed_at, so a
 * 7d view is a filter over the published 30d list rather than a second copy.
 * Returns [] when the projection is missing, which reads the same as "no slot
 * changed hands" -- the sibling counts carry the degraded signal.
 */
function subnetUidEvictions(
  projection: unknown,
  netuid: number,
  windowDays: number,
): Record<string, unknown>[] {
  const index = DeregistrationUidIndexSchema.safeParse(projection);
  const rows = index.success
    ? index.data.by_netuid?.[String(netuid)]
    : undefined;
  if (!rows) return [];
  const since = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const out: Record<string, unknown>[] = [];
  for (const candidate of rows) {
    const parsed = DeregistrationUidTupleSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const [uid, hotkey, successor, block, observedAt, tenure] = parsed.data;
    if (observedAt < since) continue;
    out.push({
      uid,
      // The DISPLACED holder -- this event is a deregistration OF this hotkey.
      hotkey,
      replaced_by_hotkey: successor,
      block_number: block,
      observed_at: new Date(observedAt).toISOString(),
      tenure_blocks: tenure,
    });
  }
  return out;
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
  if (!index) return null;
  const rows = deregistrationRowsForHotkey(index[ss58]);
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
