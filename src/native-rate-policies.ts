import type { NativeRateLimitDefinition } from "./pg-rate-limits.ts";

/** Existing declared limits, preserved by the native auth owner. */
const policies: readonly NativeRateLimitDefinition[] = [
  {
    binding: "MCP_RATE_LIMITER_COMMUNITY",
    limit: 1500,
    period: 60,
  },
  {
    binding: "MCP_RATE_LIMITER_PAID",
    limit: 5000,
    period: 60,
  },
  {
    binding: "AI_RATE_LIMITER_COMMUNITY",
    limit: 300,
    period: 60,
  },
  {
    binding: "AI_RATE_LIMITER_PAID",
    limit: 1000,
    period: 60,
  },
  {
    binding: "DATA_RATE_LIMITER_COMMUNITY",
    limit: 900,
    period: 60,
  },
  {
    binding: "DATA_RATE_LIMITER_PAID",
    limit: 3000,
    period: 60,
  },
  {
    binding: "STATE_QUERY_RATE_LIMITER_COMMUNITY",
    limit: 300,
    period: 60,
  },
  {
    binding: "STATE_QUERY_RATE_LIMITER_PAID",
    limit: 1000,
    period: 60,
  },
  {
    binding: "WEBHOOK_SUBSCRIPTION_RATE_LIMITER_COMMUNITY",
    limit: 150,
    period: 60,
  },
  {
    binding: "WEBHOOK_SUBSCRIPTION_RATE_LIMITER_PAID",
    limit: 500,
    period: 60,
  },
  {
    binding: "RPC_RATE_LIMITER",
    limit: 100,
    period: 60,
  },
  {
    binding: "MCP_RATE_LIMITER",
    limit: 100,
    period: 60,
  },
  {
    binding: "MCP_RATE_LIMITER_KEYED",
    limit: 500,
    period: 60,
  },
  {
    binding: "AI_RATE_LIMITER",
    limit: 20,
    period: 60,
  },
  {
    binding: "AI_RATE_LIMITER_KEYED",
    limit: 100,
    period: 60,
  },
  {
    binding: "DATA_RATE_LIMITER",
    limit: 60,
    period: 60,
  },
  {
    binding: "DATA_RATE_LIMITER_KEYED",
    limit: 300,
    period: 60,
  },
  {
    binding: "STATE_QUERY_RATE_LIMITER",
    limit: 20,
    period: 60,
  },
  {
    binding: "STATE_QUERY_RATE_LIMITER_KEYED",
    limit: 100,
    period: 60,
  },
  {
    binding: "WEBHOOK_SUBSCRIPTION_RATE_LIMITER",
    limit: 10,
    period: 60,
  },
  {
    binding: "WEBHOOK_SUBSCRIPTION_RATE_LIMITER_KEYED",
    limit: 50,
    period: 60,
  },
  {
    binding: "INTERNAL_SYNC_RATE_LIMITER",
    limit: 300,
    period: 60,
  },
  {
    binding: "CHAIN_FIREHOSE_INGEST_RATE_LIMITER",
    limit: 1200,
    period: 60,
  },
  {
    binding: "FULLNODE_RPC_GUESS_RATE_LIMITER",
    limit: 100,
    period: 60,
  },
  {
    binding: "FULLNODE_RPC_RATE_LIMITER",
    limit: 300,
    period: 60,
  },
  {
    binding: "FULLNODE_RPC_RATE_LIMITER_GITTENSOR",
    limit: 6000,
    period: 60,
  },
  {
    binding: "FULLNODE_RPC_RATE_LIMITER_UNLIMITED",
    limit: 100000,
    period: 60,
  },
  {
    binding: "ALERT_TRIGGER_CREATE_RATE_LIMITER",
    limit: 10,
    period: 60,
  },
  {
    binding: "WALLET_AUTH_RATE_LIMITER",
    limit: 10,
    period: 60,
  },
  {
    binding: "ACCOUNT_KEYS_MINT_RATE_LIMITER",
    limit: 10,
    period: 60,
  },
  {
    binding: "REGISTRY_SYNC_RATE_LIMITER",
    limit: 30,
    period: 60,
  },
];
export const NATIVE_RATE_POLICIES = Object.freeze(
  policies.map((policy) => Object.freeze(policy)),
);
