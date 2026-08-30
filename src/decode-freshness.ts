/**
 * How long decoded chain data may stop advancing before consumers must treat
 * it as stale. The decoder runs hourly and exhausts its own retry budget after
 * three failures, so three hours distinguishes a delayed run from a stopped
 * lane.
 *
 * This constant lives in a dependency-free leaf because both the watchdog and
 * slim data-serving bundles need it; importing either consumer from the other
 * would pull operational dependencies across Worker bundle boundaries.
 */
export const DECODE_STALE_MS = 3 * 60 * 60 * 1000;
