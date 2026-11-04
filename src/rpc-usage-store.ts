import type { RpcUsageEvent } from "./rpc-usage-capture.ts";

/** Explicit native selection; neither operation falls back to Analytics Engine. */
export interface RpcUsageStore {
  record(event: RpcUsageEvent): boolean;
  load(window: string, now: number): Promise<Record<string, unknown> | null>;
}
