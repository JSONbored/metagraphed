// The `fields=` response projection, shared by every surface that has one
// (#9082).
//
// Extracted from workers/list-query.ts, which has had `?fields=` for list
// routes for a while. The neuron routes are not list routes and so never got
// it, and a caller that has to learn a second syntax and a second error
// message for the same idea has been handed two features, not one. So this is
// the one implementation: list-query.ts calls it with its own allowed-field
// resolver, and the neuron routes call it with theirs.
//
// The two resolvers exist because the surfaces genuinely differ, not because
// the rule does:
//
//   * A list route serves a heterogeneous artifact collection with no single
//     row schema, so the only honest answer to "is this a field?" is the union
//     of keys the rows actually carry -- {@link unknownAgainstRows}.
//   * A route whose rows have a published schema can do better:
//     {@link unknownAgainstSchema} answers from the CONTRACT, so a field that
//     is declared but conditionally emitted (an immunity window that only
//     exists while a neuron is inside one) is projectable on every response
//     rather than only on the responses that happen to contain it.
//
// Both feed the same parse, the same error idiom, and the same projector.

import { recordOrNull } from "./read-store.ts";

export type Row = Record<string, unknown>;

/**
 * A field name a caller may ask for. Deliberately conservative -- an
 * identifier, nothing else -- so `fields=` can never carry a path, an index,
 * or anything that would invite treating it as an expression language.
 */
export const FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The `{parameter, message}` shape every query-parameter error already uses. */
export interface FieldProjectionError {
  parameter: string;
  message: string;
}

/**
 * `fields` null means "no projection requested" -- the caller gets the full
 * shape, byte for byte. It is not the same as an empty list, which is a
 * malformed request and reports as one.
 */
export interface FieldProjectionResult {
  fields?: string[] | null;
  error?: FieldProjectionError;
}

/**
 * Given the requested names, return the subset this surface cannot serve.
 *
 * A function rather than a `Set` so the row-union case can keep its lazy scan
 * (see {@link unknownAgainstRows}) instead of materialising every row's keys
 * to answer a question that is usually settled by the first row.
 */
export type UnknownFieldResolver = ((requested: string[]) => string[]) & {
  /**
   * The full vocabulary, for the unsupported-field message.
   *
   * Separate from the resolver call, and only ever invoked on the ERROR path,
   * because the two have opposite cost profiles: {@link unknownAgainstRows}
   * settles a VALID request from the first row and must keep doing so, while
   * listing every field necessarily materialises the union. Paying that on a
   * request that has already failed is free; paying it on every request is the
   * lazy scan thrown away.
   */
  known?: () => string[];
};

/**
 * Resolve against a published row schema -- anything in its shape is a field.
 *
 * Typed structurally (`{ shape }`) rather than as `z.ZodObject` so this module
 * pulls in no schema library: the only thing it needs from a Zod object is its
 * key set, and a dependency for `Object.keys` would be a poor trade.
 */
export function unknownAgainstSchema(schema: {
  shape: Record<string, unknown>;
}): UnknownFieldResolver {
  const allowed = new Set(Object.keys(schema.shape));
  const resolve: UnknownFieldResolver = (requested) =>
    requested.filter((field) => !allowed.has(field));
  resolve.known = () => [...allowed];
  return resolve;
}

/**
 * Resolve against the union of keys the rows actually carry.
 *
 * Scans lazily -- drop each requested field as a row reveals it, stop the
 * moment all are resolved. On the largest collection (~1160 endpoints) a valid
 * request touches ~1 row instead of materialising every row's keys; an
 * unsupported field still scans to the end to confirm it truly appears on no
 * row. Behaviour is identical to a full-union check, and identical to what
 * workers/list-query.ts did before this module existed.
 */
// `readonly object[]`, not `Row[]`: this function only ever calls
// `Object.keys(row)` -- it never indexes a row by a computed key, so requiring
// an index signature overstated what it needs. The cost of that overstatement
// was real: a caller holding a well-typed INTERFACE (`SubnetDecomposition`)
// could not pass it, because TypeScript gives implicit index signatures to type
// aliases and object literals but never to interfaces -- so the call site
// reached for a cast, and lost the row type entirely (#11339).
export function unknownAgainstRows(
  rows: readonly object[],
): UnknownFieldResolver {
  const resolve: UnknownFieldResolver = (requested) => {
    const unresolved = new Set(requested);
    for (const row of rows) {
      if (unresolved.size === 0) break;
      if (row && typeof row === "object" && !Array.isArray(row)) {
        for (const key of Object.keys(row)) unresolved.delete(key);
      }
    }
    return [...unresolved];
  };
  // The full union, which is exactly what the lazy scan above exists to avoid
  // computing. Safe here only because parseFieldsParam calls it on the error
  // path alone -- see UnknownFieldResolver.known.
  resolve.known = () => {
    const union = new Set<string>();
    for (const row of rows) {
      if (row && typeof row === "object" && !Array.isArray(row)) {
        for (const key of Object.keys(row)) union.add(key);
      }
    }
    return [...union];
  };
  return resolve;
}

/**
 * Parse and validate `fields` off a query string.
 *
 * `subject` names what the fields belong to in the unsupported-field message
 * ("neurons", "endpoints") -- the caller who asked for a field that does not
 * exist needs to know which collection it did not exist on.
 */
export function parseFieldsParam(
  params: URLSearchParams,
  resolveUnknown: UnknownFieldResolver,
  subject: string,
): FieldProjectionResult {
  if (!params.has("fields")) {
    return { fields: null };
  }
  const requested = (params.get("fields") as string)
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
        message:
          "fields must be a comma-separated list of row field names, e.g. netuid,name,slug.",
      },
    };
  }

  const fields = [...new Set(requested)];
  const unknown = resolveUnknown(fields);
  if (unknown.length > 0) {
    // Name the vocabulary, not just the miss. Two live examples of why the
    // bare form was a dead end, both from production $mcp_tool_call events:
    //
    //   get_emission_pipeline  fields=...,name    rows are pure chain state;
    //                                             `name` is registry metadata
    //                                             and lives on get_economics
    //   get_economics          total_stake_tao    the row carries
    //                                             `total_stake_alpha` -- subnet
    //                                             stake is alpha-denominated,
    //                                             so the guessed unit suffix
    //                                             names nothing
    //
    // Both refusals are CORRECT. Both were unactionable, because the caller
    // was told what it could not have and never what it could -- and in the
    // second case the field it wanted was one suffix away. This is the same
    // idiom the tool-argument guards use ("Valid fields: ...").
    const known = resolveUnknown.known?.() ?? [];
    return {
      error: {
        parameter: "fields",
        message:
          `fields includes unsupported field${unknown.length === 1 ? "" : "s"} for ${subject}: ${unknown.join(", ")}.` +
          (known.length > 0
            ? ` Valid fields: ${[...known].sort().join(", ")}.`
            : ""),
      },
    };
  }

  return { fields };
}

/**
 * Narrow one row to the requested fields.
 *
 * Keys the row does not have are skipped rather than emitted as null: a
 * conditionally-present field is absent for a reason, and inventing a null for
 * it would turn "this neuron is not in an immunity window" into "its immunity
 * window is unknown".
 */
export function projectRow<T>(row: T, fields: string[] | null | undefined): T {
  if (!fields || !row || typeof row !== "object" || Array.isArray(row)) {
    return row;
  }
  const source = recordOrNull(row) ?? {};
  return Object.fromEntries(
    fields
      .filter((field) => Object.hasOwn(source, field))
      .map((field) => [field, source[field]]),
  ) as T;
}

/**
 * {@link projectRow} across a collection.
 *
 * GENERIC, like `projectRow` beside it always was. Pinning this one to `Row[]`
 * meant a caller holding typed rows had to cast IN and back OUT again --
 * `projectRows(limited as unknown as Row[], f) as unknown as typeof subnets`
 * -- which discarded the row type across the projection for no gain (#11339).
 */
export function projectRows<T>(
  rows: T[],
  fields: string[] | null | undefined,
): T[] {
  if (!fields) {
    // The SAME array, not a copy -- the suite pins this identity, and the
    // no-projection path is the one every unnarrowed request takes.
    return rows;
  }
  return rows.map((row) => projectRow(row, fields));
}

/**
 * The `meta.projection` echo, or nothing at all when no projection ran.
 *
 * Spread into a response's meta. Absent rather than null on an unprojected
 * response so today's meta is unchanged for every caller who never asks for
 * `fields` -- and so the echo's presence is itself the signal that the body in
 * hand is narrowed, which matters when the response is cached or passed on.
 */
export function projectionMeta(fields: string[] | null | undefined): {
  projection?: { fields: string[] };
} {
  return fields ? { projection: { fields } } : {};
}
