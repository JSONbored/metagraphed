import { DEFAULT_CHAIN_NETWORK, type ChainNetworkId } from "./chain-network.ts";

/** Shared read-only capture contract; no ingestion or storage writer imports. */
interface WatermarkReadDb {
  first?(
    text: string,
    values?: unknown[],
  ): Promise<Record<string, unknown> | null>;
}

export function watermarkRead(
  db: WatermarkReadDb,
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): () => Promise<number | null> {
  return async () => {
    const row = await db.first?.(
      "SELECT last_contiguous_block FROM raw_capture_state WHERE network = ?",
      [network],
    );
    const value = row?.last_contiguous_block;
    return typeof value === "number" ? value : null;
  };
}

/** Preserve the capture lane's conservative fallback for an unreadable cron. */
export function cronStepMinutes(cron: string): number {
  const step = Number(cron.split(" ")[0]!.replace("*/", ""));
  return Number.isInteger(step) && step > 0 ? step : 5;
}
