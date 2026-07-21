// Single source of the Cloudflare KV key names, shared by the writers (the cron
// prober, the economics refresher) and the Worker readers (resolveLiveHealth /
// resolveLiveEconomics) so a key string can never drift between writer and reader
// — a typo on one side would silently degrade the live tier to its R2 fallback
// with no error. Leaf module (no imports) so any side can depend on it safely.
export const KV_HEALTH_CURRENT = "health:current" as const;
export const KV_HEALTH_RPC_POOL = "health:rpc-pool" as const;
export const KV_HEALTH_META = "health:meta" as const;
export const KV_ECONOMICS_CURRENT = "economics:current" as const;
