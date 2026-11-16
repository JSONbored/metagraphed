import type { RpcUsageEvent } from "./rpc-usage-capture.ts";

/** How far back the staleness read looks, shared by both engines' readers
 * (the PG `latest` below and the watchdog's Analytics Engine fallback).
 * Bounded so a lane that has been dead for weeks still runs a cheap query
 * rather than scanning the store's whole retention to confirm what the first
 * hour already showed. A whole number of hours: the AE dialect spells it as
 * an INTERVAL ... HOUR literal. */
export const RPC_USAGE_STALENESS_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** Explicit native selection; no operation falls back to Analytics Engine. */
export interface RpcUsageStore {
  record(event: RpcUsageEvent): boolean;
  load(window: string, now: number): Promise<Record<string, unknown> | null>;
  /** Newest captured data point inside the staleness lookback, in epoch ms;
   * null when the lookback holds no rows (#13150 -- the watchdog's read). */
  latest(now: number): Promise<number | null>;
}
