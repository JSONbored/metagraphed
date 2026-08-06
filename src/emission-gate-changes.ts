// GET /api/v1/chain/governance/emission-changes (#9615): every recorded change
// to the emission gate's governance parameters, per-subnet emission switches,
// and the dormant TAO-flow path.
//
// Three append-on-change tables (0005_emission_gate.sql) written only when a
// value actually MOVED, so the tables ARE the change log -- and read by nothing
// but their own differ. 90 + 77 + 4 rows measured 2026-08-06.
//
// The chain publishes these as CURRENT state: /network/parameters serves the
// emission-gate exponent and quantile as they are now. Nothing answered when
// they became that, or what they were before -- which is the question behind
// "did governance move the gate before that emission shift?".
//
// ## ONE FEED, THREE SHAPES, AND THE SHAPE IS PART OF THE ANSWER
//
// A param change carries a numeric before/after; a subnet switch carries a
// boolean and a netuid; a flow-watch entry carries an item name and may or may
// not be scoped to a subnet. Flattening them into one row type would either
// invent fields (a netuid for a network-wide parameter) or stringify numbers
// into a shared column. Each entry instead declares its `kind` and carries only
// the fields that kind actually has, with the rest absent rather than null-
// filled -- an absent field says "this kind has no such thing", where a null
// would say "it has one and we do not know it".
//
// ## `predates_capture` IS THE HONESTY FLAG, AND IT IS PUBLISHED
//
// The sampler records a row the first time it OBSERVES a value, not the first
// time the value changed. On that first row there is no previous reading, so
// `previous_value` is null and `predates_capture` is 1 -- meaning "this value
// was already set when we started watching; we are not claiming it changed
// here". Serving the row without the flag would present the start of our
// observation as a governance event, which is a fabricated finding on exactly
// the timeline someone would cite. Every entry carries it.
//
// `source` distinguishes a value governance SET from one the runtime
// RECOMPUTED -- two different kinds of event that a bare value cannot tell
// apart, and the reason the column exists.

import {
  EMISSION_CHANGES_LIMIT_DEFAULT,
  EMISSION_CHANGES_LIMIT_MAX,
} from "./route-limits.ts";

export { EMISSION_CHANGES_LIMIT_DEFAULT, EMISSION_CHANGES_LIMIT_MAX };

type Row = Record<string, unknown>;

export interface EmissionChangesDb {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all?(): Promise<{ results?: unknown[] } | null>;
    };
  };
}

/** The three change kinds, which are also the `?kind=` filter's vocabulary. */
export const EMISSION_CHANGE_KINDS = ["param", "subnet", "flow"] as const;
export type EmissionChangeKind = (typeof EMISSION_CHANGE_KINDS)[number];

/** How a parameter value came to be, per 0005's CHECK constraint. */
export const EMISSION_PARAM_SOURCES = [
  "governance",
  "runtime_recomputed",
] as const;

/**
 * One statement per kind, unioned in SQL so the newest-first ordering and the
 * limit apply across the whole feed rather than per table.
 *
 * Taking three separate top-N reads and merging in JS would return the newest N
 * of EACH -- so a quiet table would pad the page with old entries while a busy
 * one lost recent ones, and the "newest N changes" the route promises would be
 * neither. The union is what makes the cap mean what it says.
 *
 * The kind-specific columns are widened with NULLs inside the union because SQL
 * requires matching arity; the builder drops them again per kind, so a null
 * never reaches the payload as a field that kind does not have.
 */
export function emissionChangesSql(limit: number, kind?: string): string {
  const legs: string[] = [];
  if (!kind || kind === "param") {
    legs.push(
      "SELECT 'param' AS kind, observed_at, block_number, predates_capture," +
        " param AS key, NULL AS netuid, value, previous_value," +
        " NULL AS enabled, NULL AS previous_enabled, source" +
        " FROM emission_gate_param_history",
    );
  }
  if (!kind || kind === "subnet") {
    legs.push(
      "SELECT 'subnet' AS kind, observed_at, block_number, predates_capture," +
        " NULL AS key, netuid, NULL AS value, NULL AS previous_value," +
        " enabled, previous_enabled, NULL AS source" +
        " FROM subnet_emission_enabled_history",
    );
  }
  if (!kind || kind === "flow") {
    legs.push(
      "SELECT 'flow' AS kind, observed_at, block_number, predates_capture," +
        " item AS key, netuid, NULL AS value, NULL AS previous_value," +
        " is_set AS enabled, NULL AS previous_enabled, NULL AS source" +
        " FROM emission_flow_watch",
    );
  }
  return `${legs.join(" UNION ALL ")} ORDER BY observed_at DESC LIMIT ${limit}`;
}

/** The feed, newest first across all three tables. Null when the read fails. */
export async function loadEmissionChanges(
  db: EmissionChangesDb | null | undefined,
  {
    limit = EMISSION_CHANGES_LIMIT_DEFAULT,
    kind,
  }: { limit?: number; kind?: string } = {},
): Promise<Row[] | null> {
  if (!db?.prepare) return null;
  try {
    const res = await (
      db.prepare(emissionChangesSql(limit, kind)).bind() as {
        all?(): Promise<{ results?: unknown[] } | null>;
      }
    ).all?.();
    return (res?.results ?? []) as Row[];
  } catch {
    return null;
  }
}

/**
 * Shape the card. Pure, so the same rows produce the same payload wherever they
 * came from.
 *
 * An empty feed is a real answer: these tables only gain a row when a value
 * moves, so "nothing has changed" is the steady state and the common case.
 */
export function buildEmissionChanges(
  rows: Row[] | null | undefined,
  { limit, kind }: { limit?: number; kind?: string } = {},
): Row {
  const changes = (Array.isArray(rows) ? rows : [])
    .map((r) => shapeChange(r))
    .filter((c): c is Row => c !== null);

  return {
    schema_version: 1,
    kind: kind ?? null,
    limit: limit ?? null,
    change_count: changes.length,
    // How many entries are the FIRST observation of a value rather than a
    // change to it. A reader counting governance events must subtract these,
    // and a summary that hid them would overstate how often the gate moves.
    predates_capture_count: changes.filter((c) => c.predates_capture === true)
      .length,
    latest_change_at: changes.length ? changes[0].observed_at : null,
    changes,
  };
}

/**
 * One entry, carrying only the fields its kind actually has.
 *
 * The union widened every leg to a common column list; this narrows it back.
 * A `param` entry has no netuid and a `subnet` entry has no numeric value, and
 * omitting them is what stops a consumer reading `netuid: null` on a
 * network-wide parameter as "some subnet, unknown".
 */
function shapeChange(r: Row): Row | null {
  const kind = typeof r?.kind === "string" ? r.kind : null;
  const observedAt = toIsoOrNull(r?.observed_at);
  // Without a timestamp an entry cannot take a position in a chronological
  // feed, and a feed is an ordering.
  if (kind === null || observedAt === null) return null;

  const base: Row = {
    kind,
    observed_at: observedAt,
    block_number: intOrNull(r?.block_number),
    // Published on every entry -- see the module header. `1` means this row is
    // the first observation of the value, not a change to it.
    predates_capture: r?.predates_capture === 1 || r?.predates_capture === true,
  };

  if (kind === "param") {
    return {
      ...base,
      param: stringOrNull(r?.key),
      value: numberOrNull(r?.value),
      previous_value: numberOrNull(r?.previous_value),
      // governance vs runtime_recomputed: two different events that the value
      // alone cannot distinguish.
      source: knownSource(r?.source),
    };
  }
  if (kind === "subnet") {
    return {
      ...base,
      netuid: intOrNull(r?.netuid),
      enabled: boolOrNull(r?.enabled),
      previous_enabled: boolOrNull(r?.previous_enabled),
    };
  }
  return {
    ...base,
    item: stringOrNull(r?.key),
    // Nullable by design: the flow-watch table scopes some items to a subnet
    // and leaves others network-wide, and 0005's CHECK enforces that shape.
    netuid: intOrNull(r?.netuid),
    is_set: boolOrNull(r?.enabled),
  };
}

function knownSource(value: unknown): string | null {
  return typeof value === "string" &&
    (EMISSION_PARAM_SOURCES as readonly string[]).includes(value)
    ? value
    : null;
}

/** 0/1 with a CHECK behind it, so anything else is unreadable rather than
 * false -- `false` would assert the switch was off. */
function boolOrNull(value: unknown): boolean | null {
  if (value === 1 || value === true) return true;
  if (value === 0 || value === false) return false;
  return null;
}

function numberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function intOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toIsoOrNull(value: unknown): string | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
