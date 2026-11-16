// The mechanism (mechid) scope stamp (#13162, runtime v490; epic #13142).
//
// Ingestion dedupes `get_all_metagraphs_info(all_mechanisms=True)` to mechid 0
// (scripts/fetch-native-subnets.py, scripts/fetch-metagraph-native.py), so
// every row the neuron and weights tiers hold IS mechanism 0 -- and that is
// the one claim this module makes. A response served under an explicit
// `mechid=0` scope carries `mechid: 0`, top-level and per neuron row, because
// the dedupe is what makes the stamp true. An UNSCOPED response is returned
// untouched, byte-identical to before the parameter existed.
//
// Values above 0 never reach this module: the published contract bounds the
// parameter to 0 (schemas-src/query-params.ts's mechidSchema -- the
// enforce-what-you-publish posture of #10096), REST rejects it centrally in
// parseRouteQuery, and the GraphQL/MCP mirrors reject it with
// assertMechanismScopeArgument below. Serving an empty snapshot for mechid 1
// instead would fabricate "mechanism 1 has no neurons" on exactly the subnets
// where it does (9/129 on the owner's 11-05 audit). The ceiling widens when
// mechanism-keyed capture lands with the engine.

type Row = Record<string, unknown>;

/** The sentence every surface rejects an out-of-range mechid with. */
export const MECHANISM_SCOPE_MESSAGE =
  "mechid must be 0: mechanism 0 is the only captured mechanism until " +
  "mechanism-aware capture lands (#13162).";

/**
 * True when a supplied mechanism argument cannot be served honestly.
 *
 * `null`/`undefined` is "unscoped", which is always servable; 0 is the one
 * scope today's stores hold. GraphQL and MCP arrive here as real JSON, so a
 * non-integer is rejected alongside the out-of-range values rather than
 * truncated into one.
 */
export function invalidMechanismScope(
  mechid: number | null | undefined,
): boolean {
  return mechid != null && !(Number.isInteger(mechid) && mechid === 0);
}

/**
 * Stamp a mechanism-scoped payload with the scope that was requested.
 *
 * `mechid == null` (no scope requested) returns the payload UNTOUCHED, so the
 * default response stays byte-identical. Otherwise the artifact gains a
 * top-level `mechid`, and -- where the payload carries neuron rows (`neurons`
 * arrays, a nullable `neuron` card) -- each row gains the same `mechid`,
 * because the rows are what the scope describes. A null `neuron` stays null:
 * "absent from the snapshot" has no mechanism to report.
 */
export function stampMechanismScope<T extends Row>(
  data: T,
  mechid: number | null | undefined,
): T {
  if (mechid == null || !data || typeof data !== "object") return data;
  const stamped: Row = { ...data, mechid };
  if (Array.isArray(stamped.neurons)) {
    stamped.neurons = (stamped.neurons as Row[]).map((row) => ({
      ...row,
      mechid,
    }));
  }
  if (
    Object.hasOwn(stamped, "neuron") &&
    stamped.neuron !== null &&
    typeof stamped.neuron === "object"
  ) {
    stamped.neuron = { ...(stamped.neuron as Row), mechid };
  }
  return stamped as T;
}
