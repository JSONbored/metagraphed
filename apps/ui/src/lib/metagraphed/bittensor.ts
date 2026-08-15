/**
 * Bittensor protocol facts — the ones that are structurally fixed, not live data.
 *
 * #11320: these are here so a page title can state a number without a
 * per-request fetch. The distinction that earns this module its existence:
 *
 *   - A registration changes WHICH project occupies a netuid, not how many
 *     netuids exist. SN1 may be a different team next month; there are still
 *     128 of them. (This repo already records the consequence elsewhere as
 *     "a netuid is an unstable join key" — the identity churns, the
 *     cardinality does not.)
 *   - Counts that DO vary — surfaces, providers, validators, first-party
 *     coverage — are live data and must come from a loader, never from here.
 *
 * Dependency-free on purpose, like identity.ts: imported by route `head()`
 * (which runs in the Worker) and by components (which run in the browser).
 */

/**
 * Active application subnets, capped by the protocol.
 *
 * **128, not 129.** 129 is `chain_subnet_count` — this plus root. Root
 * (netuid 0) is governance and emission routing, not a subnet anyone browsing
 * a list of subnets means, and a title claiming 129 would disagree with the
 * 128 rows the page lists. A heading that renames the thing it labels is the
 * same defect as a breadcrumb that renames its own target (#11303).
 *
 * `scripts/validate-subnet-slot-cap.ts` fails CI if the registry stops
 * matching this. Bittensor governance has discussed raising the cap; a red
 * build is how we should find out it moved, not a wrong number sitting in
 * Google's index for months.
 */
export const SUBNET_SLOT_CAP = 128;

/** Root — governance and emission routing, not an application subnet. */
export const ROOT_NETUID = 0;

/**
 * Every netuid the chain defines, root included.
 *
 * Derived rather than written as `129` so the two can never disagree, which is
 * the whole failure mode this module exists to prevent.
 */
export const CHAIN_SUBNET_COUNT = SUBNET_SLOT_CAP + 1;
