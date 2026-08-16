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

/**
 * IPv6 ranges nobody can route to: unspecified `::`, loopback `::1`,
 * unique-local `fc00::/7`, and link-local `fe80::/10`.
 *
 * Separate from the IPv4 pattern because the two are different address
 * families, not different spellings -- `10.` and `10::` share a prefix and
 * mean unrelated things.
 */
export const UNROUTABLE_AXON_V6_PATTERN =
  "^(::$|::1$|[fF][cCdD]|[fF][eE][89aAbB])";

/** SQL fragment: the axon is present AND points somewhere routable.
 *
 * `left(axon, length(axon) - strpos(reverse(axon), ':'))` is "everything before
 * the LAST colon" -- the same address/port split `splitAxon` does, so an IPv6
 * announcement is not read as its first hex group. */
export const AXON_ADDRESS_SQL =
  "left(axon, length(axon) - strpos(reverse(axon), ':'))";
export const ROUTABLE_AXON_SQL =
  `axon IS NOT NULL AND axon <> '' AND ${AXON_ADDRESS_SQL} <> '' AND ` +
  `CASE WHEN ${AXON_ADDRESS_SQL} LIKE '%:%' ` +
  `THEN ${AXON_ADDRESS_SQL} !~ '${UNROUTABLE_AXON_V6_PATTERN}' ` +
  `ELSE ${AXON_ADDRESS_SQL} !~ '${UNROUTABLE_AXON_PATTERN}' END`;

/**
 * Split an announced axon into address and port.
 *
 * THE PORT IS AFTER THE LAST COLON, not the second. IPv4 makes the two look
 * identical (`1.2.3.4:8091`), which is why the naive split survived review --
 * but an IPv6 axon is `2607:fb90:...:1036:10000`, where taking component two
 * yields `fb90` as the port and `2607` as the address. Measured 2026-08-16,
 * three announcements on SN12/SN51/SN56 are IPv6 and were being parsed that
 * way; they classified correctly only by accident, because `2607` matches no
 * IPv4 unroutable prefix. An IPv6 loopback would have read as routable.
 */
export function splitAxon(axon: string): { address: string; port: string } {
  const cut = axon.lastIndexOf(":");
  if (cut < 0) return { address: axon, port: "" };
  return { address: axon.slice(0, cut), port: axon.slice(cut + 1) };
}

/** The same rule as the SQL, in JS, for callers holding a row. */
export function isRoutableAxon(axon: unknown): boolean {
  if (typeof axon !== "string" || axon === "") return false;
  const { address } = splitAxon(axon);
  if (address === "") return false;
  // An address carrying a colon is IPv6 and gets the IPv6 rules; applying the
  // IPv4 prefixes to it would compare a hex group against a dotted quad.
  return address.includes(":")
    ? !new RegExp(UNROUTABLE_AXON_V6_PATTERN).test(address)
    : !new RegExp(UNROUTABLE_AXON_PATTERN).test(address);
}
