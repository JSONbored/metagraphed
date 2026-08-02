// The `?fields=` projection primitive, shared by every route that has one
// (#9082).
//
// It began inside workers/list-query.ts, where the allowed field set is the
// UNION OF KEYS PRESENT IN THE RETURNED ROWS. That is the right rule for a
// heterogeneous collection, and the wrong one for a schema whose fields are
// optional: NeuronSchema's `immunity_expires_at_block` is emitted only for a
// neuron currently inside its immunity window, so on a subnet where nobody is,
// a row-union check rejects `?fields=immunity_expires_at_block` as
// "unsupported" when it is a perfectly good field of the published contract.
//
// So the resolution is parameterised on the allowed set rather than assuming
// where it comes from: list routes keep passing their row union, and the
// neuron routes pass the key set derived from NeuronSchema itself. One
// implementation, one syntax, one error idiom, and a projection map that could
// drift away from the contract never exists.

/** The shape workers/list-query.ts already returns for a bad query param. */
export interface FieldProjectionError {
  parameter: string;
  message: string;
}

export interface FieldProjectionResult {
  /** The de-duplicated field list, or null when `fields` was absent (= all). */
  fields?: string[] | null;
  error?: FieldProjectionError;
}

// A field name is an identifier: it addresses a key of a published row, so
// anything that could not BE such a key is a malformed request rather than an
// unknown field, and gets the syntax error instead of the unsupported-field
// one.
const FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Split and syntax-check a raw `fields` value. Null when absent. */
export function parseFieldsParam(
  raw: string | null | undefined,
  example = "netuid,name,slug",
): FieldProjectionResult {
  if (raw == null) return { fields: null };
  const requested = raw
    .split(",")
    .map((field) => field.trim())
    .filter((field) => field.length > 0);
  if (
    requested.length === 0 ||
    requested.some((field) => !FIELD_NAME_PATTERN.test(field))
  ) {
    return {
      error: {
        parameter: "fields",
        message: `fields must be a comma-separated list of row field names, e.g. ${example}.`,
      },
    };
  }
  return { fields: [...new Set(requested)] };
}

/**
 * Resolve an already-parsed field list against an allowed set.
 *
 * `isAllowed` is a predicate, not a Set, so a caller whose allowed set is
 * expensive to materialise can answer lazily -- which is what keeps
 * list-query.ts's row-union scan able to stop at the first row that resolves
 * every requested field instead of walking ~1160 rows to build a union it
 * mostly does not need.
 */
export function resolveFieldProjection(
  fields: string[],
  isAllowed: (field: string) => boolean,
  dataKey: string,
): FieldProjectionResult {
  const unknown = fields.filter((field) => !isAllowed(field));
  if (unknown.length > 0) {
    return {
      error: {
        parameter: "fields",
        message: `fields includes unsupported field${
          unknown.length === 1 ? "" : "s"
        } for ${dataKey}: ${unknown.join(", ")}.`,
      },
    };
  }
  return { fields };
}

/**
 * Narrow each row to the requested fields. A null/absent field list returns
 * the rows untouched (the no-projection case), and a field a given row does
 * not carry is OMITTED from that row rather than emitted as null -- the same
 * absent-not-null convention the row shapes themselves use for an optional
 * field.
 */
export function projectRows<T>(
  rows: T[],
  fields: string[] | null | undefined,
): T[] {
  if (!fields) return rows;
  return rows.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return row;
    const source = row as Record<string, unknown>;
    return Object.fromEntries(
      fields
        .filter((field) => Object.hasOwn(source, field))
        .map((field) => [field, source[field]]),
    ) as T;
  });
}

/** Project a single object (the neuron-detail case), same rules as projectRows. */
export function projectRow<T>(row: T, fields: string[] | null | undefined): T {
  if (!fields || !row || typeof row !== "object") return row;
  return projectRows([row], fields)[0] as T;
}
