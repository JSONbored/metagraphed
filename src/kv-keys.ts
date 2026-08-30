// Single source of the Cloudflare KV key names, shared by the writers (the cron
// prober, the economics refresher) and the Worker readers (resolveLiveHealth /
// resolveLiveEconomics) so a key string can never drift between writer and reader
// — a typo on one side would silently degrade the live tier to its R2 fallback
// with no error. Leaf module (no imports) so any side can depend on it safely.
export const KV_HEALTH_CURRENT = "health:current" as const;
export const KV_HEALTH_RPC_POOL = "health:rpc-pool" as const;
export const KV_HEALTH_META = "health:meta" as const;
export const KV_ECONOMICS_CURRENT = "economics:current" as const;
/**
 * The small pointer to the account-holder and validator-operator directories
 * derived from the newest materialized neuron snapshot. The payload itself is
 * versioned by captured_at so an eventually-consistent pointer can never make
 * a reader mistake the previous snapshot for the new one.
 */
export const KV_EXPLORER_DIRECTORIES_CURRENT =
  "explorer-directories:v1:current" as const;
export const KV_EXPLORER_DIRECTORIES_SNAPSHOT_PREFIX =
  "explorer-directories:v1:snapshot" as const;

export function explorerDirectoriesSnapshotKey(capturedAt: number): string {
  return `${KV_EXPLORER_DIRECTORIES_SNAPSHOT_PREFIX}:${capturedAt}`;
}
/**
 * The newest TAO/USD reading, so a consumer can price alpha without a DB read.
 *
 * WHY KV AND NOT A NEON READ (#10381). `tao_usd_index` is the durable series
 * and stays so — this is a hot-path copy of its newest row, nothing more.
 * /api/v1/economics serves from KV (economics:current) with an R2 fallback and
 * touches NO database; adding a Postgres read there to multiply by one number
 * would give a hot, currently DB-free route a new dependency and a new way to
 * fail. Written by the same minute-cadence tick that writes the row, read
 * beside the economics blob it is composed with.
 *
 * Not the lakehouse either, which is worth stating because the Neon-hot /
 * lakehouse-cold split is the right instinct nearly everywhere else here. It
 * inverts for price data: the table is ~6 MB for eight days against the
 * lakehouse's million-row chain tables, the dominant read is a point lookup of
 * the newest row rather than a scan, and R2_SQL_TOKEN is bound to the main
 * Worker only — data-api, which both writes this tick and serves /economics,
 * cannot reach the lakehouse at all.
 *
 * EVENTUALLY CONSISTENT, deliberately. A reader can briefly see a rate a few
 * seconds older than Neon's newest row, so /economics and /network/tao-usd can
 * momentarily disagree in the last digits. Harmless at a one-minute cadence
 * against a two-hour staleness bound — but every value carries the block it
 * came from, so a caller comparing the two can always tell which instant each
 * figure describes rather than having to assume they match.
 */
export const KV_TAO_USD_CURRENT = "tao-usd:current" as const;
