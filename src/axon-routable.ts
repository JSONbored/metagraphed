// Whether an announced axon points anywhere on the public internet (#11373).
//
// Shared by the serving path (src/metagraph-neurons.ts, which publishes
// `axon_routable`) and the watchdog (src/axon-announcement-watchdog.ts, which
// counts only routable announcements). ONE definition: a second copy would be
// free to drift, and the two answers would disagree about the same row.

/**
 * Address ranges an announced axon can carry that nobody can route to.
 *
 * ONE PATTERN, used to build the SQL predicate and available as a RegExp for
 * tests, so the rule cannot drift between where it is enforced and where it is
 * described. Covers RFC 5737 documentation space, RFC 1918 private space,
 * loopback, and the unspecified `0.0.0.0/8`.
 *
 * MEASURED 2026-08-16, this is not hypothetical: 347 of 6,532 announced axons
 * (5.3%) sit in these ranges, and 246 of those miners earn incentive. SN33 is
 * almost all of it -- 247 of its 251 announcements are `192.0.2.1`, a single
 * RFC 5737 documentation address, and those miners take 99.82% of the subnet's
 * incentive while the four announcing routable addresses earn nothing (#11373).
 *
 * COUNTING THEM AS ANNOUNCING MAKES THIS WATCHDOG BLIND in the one direction it
 * exists to watch: a subnet could lose every real endpoint and read as
 * perfectly healthy while its placeholder count held steady.
 */
export const UNROUTABLE_AXON_PATTERN =
  "^(0\\.|10\\.|127\\.|192\\.168\\.|192\\.0\\.2\\.|198\\.51\\.100\\.|203\\.0\\.113\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.)";

/** SQL fragment: the axon is present AND points somewhere routable. */
export const ROUTABLE_AXON_SQL = `axon IS NOT NULL AND axon <> '' AND split_part(axon, ':', 1) !~ '${UNROUTABLE_AXON_PATTERN}'`;

/** The same rule in JS, for callers holding a row rather than writing SQL. */
export function isRoutableAxon(axon: unknown): boolean {
  if (typeof axon !== "string" || axon === "") return false;
  // `split(":", 1).join("")` rather than indexing: `split` always yields at
  // least one element, so a `?? ""` guard on `[0]` would be a branch nothing
  // could reach, and a test written to reach it could only assert the code's
  // own assumption back at it.
  const ip = axon.split(":", 1).join("");
  if (ip === "") return false;
  return !new RegExp(UNROUTABLE_AXON_PATTERN).test(ip);
}
