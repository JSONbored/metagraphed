// Shared retention policy; independent of the outbound burn capture transport.

/**
 * How long a captured price is kept.
 *
 * 90 days matches the window the health surfaces already report over, so an operator
 * comparing a burn series against uptime is looking at the same span. The table grows
 * by one row per subnet per tick, so at 129 subnets on a 15-minute cadence that is
 * ~1.1M rows at steady state -- small, but unbounded growth with no policy is how a
 * table becomes someone's problem years later.
 */
export const BURN_HISTORY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
