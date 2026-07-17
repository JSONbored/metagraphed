// Shared chain-signers constants for REST + MCP parity (#2342). The D1 loader
// (loadChainSigners) that ran a live extrinsics-tier query was removed under
// the #4772 D1 retirement -- the `extrinsics` D1 table was fully dropped, so
// that fallback always hit an empty table. Postgres is the sole live tier now
// (workers/data-api.mjs); a cold/absent tier falls back to
// buildChainSigners([...]) directly (./chain-analytics.mjs), never D1.

export const CHAIN_SIGNERS_SORTS = ["tx_count", "total_fee_tao"];
export const CHAIN_SIGNERS_LIMIT_DEFAULT = 50;
export const CHAIN_SIGNERS_LIMIT_MAX = 100;
