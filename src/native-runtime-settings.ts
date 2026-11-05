import type { NativeCronOwner } from "./pg-cron.ts";

/** The current reviewed Worker scalars, excluding retired storage/telemetry
 * selectors. Native capability objects are constructed separately. */
export const NATIVE_ROLE_DEFAULTS = Object.freeze({
  api: {
    ARCHIVE_OBJECT_STORAGE: "native",
    NATIVE_PROJECTIONS: "enabled",
    RETAINED_BLOCKS_NETWORKS: "mainnet,testnet",
    X402_PAY_TO: "0x224809C91CF942d00ef04b23f7BaB87d5DA5013f",
    X402_NETWORK: "eip155:84532",
    X402_PAY_TO_SOLANA: "EQvVxQ9WShSUjSUj8rod2PFRcQfZ4Ymejx6hJLFMsx87",
    METAGRAPH_CONTRACT_VERSION: "2026-07-03.2",
    METAGRAPH_ENABLE_RPC_PROXY: "true",
    METAGRAPH_R2_LATEST_PREFIX: "latest/",
    METAGRAPH_VALIDATE_RESPONSES: "true",
    METAGRAPH_AUDIT_RESPONSES: "enforce",
    METAGRAPH_ENABLE_AI: "true",
    RAW_CAPTURE_ENABLED: "true",
    ICEBERG_BLOCKS_MAX: "8759336",
    METAGRAPH_NEURONS_SOURCE: "data-api",
    POSTHOG_TRACES_SAMPLE_RATE_MCP: "0.25",
    POSTHOG_USAGE_SAMPLE_RATE: "0.015",
    POSTHOG_USAGE_SAMPLE_RATES: '{"block-detail":0.005}',
    POSTHOG_EXCEPTION_STORM_WINDOW_MS: "300000",
    METAGRAPH_SUBNET_HYPERPARAMS_SOURCE: "data-api",
    METAGRAPH_ACCOUNT_IDENTITY_SOURCE: "data-api",
    METAGRAPH_SUBNET_IDENTITY_SOURCE: "retired",
    METAGRAPH_HEALTH_SOURCE: "data-api",
    CHAIN_HEAD_POLL_ENABLED: "true",
    CHAIN_HEAD_RPC_URL: "https://archive.chain.opentensor.ai",
    CHAIN_HEAD_POLL_INTERVAL_MS: "6000",
    CHAIN_HEAD_EVENT_COUNT_ENABLED: "true",
    CHAIN_HEAD_AUTHOR_ENABLED: "true",
    TESTNET_CHAIN_HEAD_RPC_URL: "https://test.finney.opentensor.ai:443",
    GITHUB_OAUTH_CLIENT_ID: "Ov23liz4NzqUvC8YrKMS",
  },
  data: {
    ARCHIVE_OBJECT_STORAGE: "native",
    NATIVE_PROJECTIONS: "enabled",
    RETAINED_BLOCKS_NETWORKS: "mainnet,testnet",
    UNKEY_API_ID: "api_2Dv8cVjrTSiD",
    METAGRAPH_NEURONS_SOURCE: "data-api",
    METAGRAPH_SUBNET_HYPERPARAMS_SOURCE: "data-api",
    METAGRAPH_ACCOUNT_IDENTITY_SOURCE: "data-api",
    SYNC_QUEUE_LANES:
      "account-balances,hotkey-alpha,validator-nominator-counts,nominator-positions,chain-detail",
    POSTHOG_EXCEPTION_STORM_WINDOW_MS: "300000",
    POSTHOG_TRACES_SAMPLE_RATE: "0.002",
  },
  registry: {
    POSTHOG_EXCEPTION_STORM_WINDOW_MS: "300000",
    POSTHOG_TRACES_SAMPLE_RATE: "1",
  },
} as const);

export const NATIVE_SETTING_KEYS = Object.freeze([
  "ACCOUNT_BALANCES_SYNC_SECRET",
  "ACCOUNT_IDENTITY_SYNC_SECRET",
  "ACCOUNT_TIER_PROMOTE_INTERNAL_TOKEN",
  "ALERT_TRIGGERS_INTERNAL_TOKEN",
  "ALERT_TRIGGER_CREATE_TOKEN",
  "API_KEY_BLOCK_INTERNAL_TOKEN",
  "API_KEY_LOOKUP_INTERNAL_TOKEN",
  "ARCHIVE_OBJECT_STORAGE",
  "CHAIN_DETAIL_STALENESS_THRESHOLD_MS",
  "CHAIN_DETAIL_SYNC_SECRET",
  "CHAIN_FIREHOSE_SYNC_SECRET",
  "CHAIN_HEAD_AUTHOR_ENABLED",
  "CHAIN_HEAD_EVENT_COUNT_ENABLED",
  "CHAIN_HEAD_POLL_ENABLED",
  "CHAIN_HEAD_POLL_INTERVAL_MS",
  "CHAIN_HEAD_RPC_URL",
  "EMISSION_DRIFT_RPC_URL",
  "EMISSION_GATE_SYNC_SECRET",
  "EMISSION_SAMPLER_RPC_URL",
  "ETH_RPC_URL",
  "FULLNODE_RPC_ORIGINS",
  "GITHUB_OAUTH_CLIENT_ID",
  "GITHUB_OAUTH_CLIENT_SECRET",
  "GITHUB_SIGNALS_TOKEN",
  "GITHUB_TOKEN",
  "HEALTH_CHECKS_SYNC_SECRET",
  "HOTKEY_ALPHA_SYNC_SECRET",
  "ICEBERG_BLOCKS_MAX",
  "LANE_ALARM_GITHUB_TOKEN",
  "LIVE_ALERT_WEBHOOK_URL",
  "LIVE_ECONOMICS_RPC_URL",
  "MCP_PROBE_TOKEN",
  "MCP_SURFACE_CREDENTIAL_SECRET",
  "METAGRAPH_ACCOUNT_IDENTITY_SOURCE",
  "METAGRAPH_ALLOW_R2_STATIC_FALLBACK",
  "METAGRAPH_AUDIT_RESPONSES",
  "METAGRAPH_BOT_SIGNING_KEY",
  "METAGRAPH_CONTRACT_VERSION",
  "METAGRAPH_DISABLE_REQUEST_LOGS",
  "METAGRAPH_ENABLE_AI",
  "METAGRAPH_ENABLE_RPC_PROXY",
  "METAGRAPH_HEALTH_MAX_AGE_HOURS",
  "METAGRAPH_HEALTH_SOURCE",
  "METAGRAPH_ICON_ALLOWED_HOSTS",
  "METAGRAPH_NEURONS_SOURCE",
  "METAGRAPH_R2_LATEST_PREFIX",
  "METAGRAPH_R2_TIMEOUT_MS",
  "METAGRAPH_SUBNET_HYPERPARAMS_SOURCE",
  "METAGRAPH_SUBNET_IDENTITY_SOURCE",
  "METAGRAPH_VALIDATE_RESPONSES",
  "METAGRAPH_WEBHOOK_SUBSCRIPTION_TOKEN",
  "NATIVE_PROJECTIONS",
  "NEURONS_SYNC_SECRET",
  "NEURON_DAILY_BACKFILL_SECRET",
  "NOMINATOR_POSITIONS_SYNC_SECRET",
  "POLLER_LANE_HEALTH_SYNC_SECRET",
  "POSTHOG_EXCEPTION_STORM_WINDOW_MS",
  "POSTHOG_HOST",
  "POSTHOG_PROJECT_TOKEN",
  "POSTHOG_TRACES_SAMPLE_RATE",
  "POSTHOG_TRACES_SAMPLE_RATE_MCP",
  "POSTHOG_USAGE_SAMPLE_RATE",
  "POSTHOG_USAGE_SAMPLE_RATES",
  "RAW_CAPTURE_ENABLED",
  "REGISTRY_SYNC_SECRET",
  "RESEND_API_KEY",
  "RESEND_FROM_ADDRESS",
  "RETAINED_BLOCKS_NETWORKS",
  "RETAINED_BLOCKS_SYNC_SECRET",
  "ROLLUP_SYNC_SECRET",
  "ROOT_BASKET_CAPTURE_SYNC_SECRET",
  "RPC_USAGE_STALENESS_THRESHOLD_MS",
  "RPC_USAGE_SYNC_SECRET",
  "SELF_STAKE_SYNC_SECRET",
  "STATE_EXPORT_SECRET",
  "SUBNET_HYPERPARAMS_SYNC_SECRET",
  "SUBNET_IDENTITY_SYNC_SECRET",
  "SUBNET_LOCKS_SYNC_SECRET",
  "SUBNET_OWNERSHIP_SYNC_SECRET",
  "SUBNET_SNAPSHOT_SYNC_SECRET",
  "SYNC_QUEUE_LANES",
  "TELEGRAM_BOT_TOKEN",
  "TESTNET_CHAIN_HEAD_RPC_URL",
  "UNKEY_API_ID",
  "UNKEY_ROOT_KEY",
  "USAGE_DISTINCT_ID_SALT",
  "VALIDATOR_NOMINATOR_COUNTS_SYNC_SECRET",
  "VAPID_PRIVATE_KEY",
  "VAPID_PUBLIC_KEY",
  "VAPID_SUBJECT",
  "WALLET_SESSION_SECRET",
  "WATCH_TRIGGER_TOKEN_SECRET",
  "WEBHOOK_DISPATCH_SECRET",
  "X402_FACILITATOR_URL",
  "X402_NETWORK",
  "X402_NETWORK_SOLANA",
  "X402_PAY_TO",
  "X402_PAY_TO_SOLANA",
] as const);
export type NativeSettingKey = (typeof NATIVE_SETTING_KEYS)[number];
export type NativeRuntimeSettings = Readonly<
  Partial<Record<NativeSettingKey, string>>
>;
for (const defaults of Object.values(NATIVE_ROLE_DEFAULTS))
  Object.freeze(defaults);

const fixed = {
  api: [
    "ARCHIVE_OBJECT_STORAGE",
    "NATIVE_PROJECTIONS",
    "RETAINED_BLOCKS_NETWORKS",
    "METAGRAPH_ENABLE_RPC_PROXY",
    "METAGRAPH_VALIDATE_RESPONSES",
    "METAGRAPH_AUDIT_RESPONSES",
    "METAGRAPH_ENABLE_AI",
    "RAW_CAPTURE_ENABLED",
    "METAGRAPH_NEURONS_SOURCE",
    "METAGRAPH_SUBNET_HYPERPARAMS_SOURCE",
    "METAGRAPH_ACCOUNT_IDENTITY_SOURCE",
    "METAGRAPH_SUBNET_IDENTITY_SOURCE",
    "METAGRAPH_HEALTH_SOURCE",
    "CHAIN_HEAD_POLL_ENABLED",
    "CHAIN_HEAD_EVENT_COUNT_ENABLED",
    "CHAIN_HEAD_AUTHOR_ENABLED",
  ],
  data: [
    "ARCHIVE_OBJECT_STORAGE",
    "NATIVE_PROJECTIONS",
    "RETAINED_BLOCKS_NETWORKS",
    "METAGRAPH_NEURONS_SOURCE",
    "METAGRAPH_SUBNET_HYPERPARAMS_SOURCE",
    "METAGRAPH_ACCOUNT_IDENTITY_SOURCE",
    "SYNC_QUEUE_LANES",
  ],
  registry: [],
} as const;
export const NATIVE_REQUIRED_SECRETS = Object.freeze({
  api: [
    "MCP_SURFACE_CREDENTIAL_SECRET",
    "EMISSION_GATE_SYNC_SECRET",
    "ETH_RPC_URL",
    "REGISTRY_SYNC_SECRET",
    "ACCOUNT_TIER_PROMOTE_INTERNAL_TOKEN",
    "API_KEY_BLOCK_INTERNAL_TOKEN",
    "API_KEY_LOOKUP_INTERNAL_TOKEN",
    "GITHUB_OAUTH_CLIENT_SECRET",
    "CHAIN_FIREHOSE_SYNC_SECRET",
    "STATE_EXPORT_SECRET",
    "HEALTH_CHECKS_SYNC_SECRET",
    "RETAINED_BLOCKS_SYNC_SECRET",
    "ROOT_BASKET_CAPTURE_SYNC_SECRET",
    "RPC_USAGE_SYNC_SECRET",
    "WEBHOOK_DISPATCH_SECRET",
    "METAGRAPH_WEBHOOK_SUBSCRIPTION_TOKEN",
    "GITHUB_TOKEN",
    "GITHUB_SIGNALS_TOKEN",
    "WALLET_SESSION_SECRET",
    "WATCH_TRIGGER_TOKEN_SECRET",
    "ALERT_TRIGGER_CREATE_TOKEN",
    "ALERT_TRIGGERS_INTERNAL_TOKEN",
  ],
  data: [
    "ACCOUNT_BALANCES_SYNC_SECRET",
    "ACCOUNT_IDENTITY_SYNC_SECRET",
    "ACCOUNT_TIER_PROMOTE_INTERNAL_TOKEN",
    "ALERT_TRIGGERS_INTERNAL_TOKEN",
    "ALERT_TRIGGER_CREATE_TOKEN",
    "API_KEY_BLOCK_INTERNAL_TOKEN",
    "API_KEY_LOOKUP_INTERNAL_TOKEN",
    "CHAIN_DETAIL_SYNC_SECRET",
    "HOTKEY_ALPHA_SYNC_SECRET",
    "NEURONS_SYNC_SECRET",
    "NEURON_DAILY_BACKFILL_SECRET",
    "NOMINATOR_POSITIONS_SYNC_SECRET",
    "POLLER_LANE_HEALTH_SYNC_SECRET",
    "SELF_STAKE_SYNC_SECRET",
    "SUBNET_HYPERPARAMS_SYNC_SECRET",
    "SUBNET_IDENTITY_SYNC_SECRET",
    "SUBNET_OWNERSHIP_SYNC_SECRET",
    "UNKEY_ROOT_KEY",
    "VALIDATOR_NOMINATOR_COUNTS_SYNC_SECRET",
    "WALLET_SESSION_SECRET",
    "WATCH_TRIGGER_TOKEN_SECRET",
    "STATE_EXPORT_SECRET",
  ],
  registry: ["REGISTRY_SYNC_SECRET"],
} as const);

for (const secrets of Object.values(NATIVE_REQUIRED_SECRETS))
  Object.freeze(secrets);

/** Parse only scalar settings; callers cannot install a store or silently
 * disable an active feature through an arbitrary environment object. */
export function nativeRuntimeSettings(
  owner: NativeCronOwner,
  supplied: unknown,
): NativeRuntimeSettings {
  if (!Object.hasOwn(NATIVE_ROLE_DEFAULTS, owner))
    throw new TypeError("Unknown native settings owner");
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied))
    throw new TypeError(`Native ${owner} settings are required`);
  const entries = Object.entries(supplied);
  if (entries.length > 256)
    throw new RangeError("Native settings exceed their count budget");
  const defaults: NativeRuntimeSettings = NATIVE_ROLE_DEFAULTS[owner];
  const values: Partial<Record<NativeSettingKey, string>> = { ...defaults };
  for (const [key, value] of entries) {
    if (!(NATIVE_SETTING_KEYS as readonly string[]).includes(key))
      throw new TypeError(`Unsupported native setting: ${key}`);
    if (
      typeof value !== "string" ||
      new TextEncoder().encode(value).length > 65536 ||
      value.includes("\0")
    )
      throw new TypeError(`Invalid native setting: ${key}`);
    values[key as NativeSettingKey] = value;
  }
  for (const key of fixed[owner]) {
    if (values[key] !== defaults[key])
      throw new Error(`Native ${owner} must preserve active setting: ${key}`);
  }
  for (const key of NATIVE_REQUIRED_SECRETS[owner])
    if (!values[key]?.trim())
      throw new Error(`Native ${owner} requires setting: ${key}`);
  return Object.freeze(values);
}

/** Internal callers and their destination owners share the same credentials. */
export function nativeSettingsByOwner(
  supplied: unknown,
): Readonly<Record<NativeCronOwner, NativeRuntimeSettings>> {
  if (
    !supplied ||
    typeof supplied !== "object" ||
    Array.isArray(supplied) ||
    Object.keys(supplied).some(
      (name) => !["api", "data", "registry"].includes(name),
    )
  )
    throw new TypeError(
      "Native settings require only the three application owners",
    );
  const settings = {
    api: nativeRuntimeSettings("api", Reflect.get(supplied, "api")),
    data: nativeRuntimeSettings("data", Reflect.get(supplied, "data")),
    registry: nativeRuntimeSettings(
      "registry",
      Reflect.get(supplied, "registry"),
    ),
  };
  for (const key of [
    "ACCOUNT_TIER_PROMOTE_INTERNAL_TOKEN",
    "API_KEY_BLOCK_INTERNAL_TOKEN",
    "API_KEY_LOOKUP_INTERNAL_TOKEN",
    "ALERT_TRIGGERS_INTERNAL_TOKEN",
    "ALERT_TRIGGER_CREATE_TOKEN",
    "STATE_EXPORT_SECRET",
    "WALLET_SESSION_SECRET",
    "WATCH_TRIGGER_TOKEN_SECRET",
  ] as const)
    if (settings.api[key] !== settings.data[key])
      throw new Error(`Native internal credential differs: ${key}`);
  if (
    settings.api.REGISTRY_SYNC_SECRET !== settings.registry.REGISTRY_SYNC_SECRET
  )
    throw new Error("Native internal credential differs: REGISTRY_SYNC_SECRET");
  return Object.freeze(settings);
}
