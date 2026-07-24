// Supplemental `Env` fields `wrangler types` can't see (metagraphed#7513).
//
// `npm run types:workers` generates `Env` from each wrangler*.jsonc's
// COMMITTED `vars`/bindings only. Runtime-only overrides — deploy-time
// `wrangler secret put` values, dashboard-set vars, and env vars this repo's
// own scripts/tests set locally to override a default (`process.env.X` read
// via `env.X` in a Worker context) — are real, legitimate `env.X` reads
// throughout `workers/` and `src/`, but never appear in any wrangler*.jsonc,
// so the generated interface doesn't declare them and every such access
// would otherwise fail to typecheck.
//
// This file is interface-merged with the three generated `Env` declarations
// (TypeScript combines all top-level `interface Env` declarations across the
// program). Hand-maintained, unlike the three `*.worker-configuration.d.ts`
// files — add a field here (as `string | undefined`, since an unset runtime
// var reads as `undefined`, not absent) the first time a real `env.X` access
// needs a type and `X` isn't in any wrangler*.jsonc `vars` block. Keep it
// alphabetized; don't add a field speculatively for something not yet read
// anywhere.
interface Env {
  ACCOUNT_BALANCES_SYNC_SECRET?: string;
  ACCOUNT_IDENTITY_SYNC_SECRET?: string;
  ACCOUNT_TIER_PROMOTE_INTERNAL_TOKEN?: string;
  ALERT_TRIGGER_CREATE_TOKEN?: string;
  ALERT_TRIGGERS_INTERNAL_TOKEN?: string;
  API_KEY_LOOKUP_INTERNAL_TOKEN?: string;
  CHAIN_FIREHOSE_SYNC_SECRET?: string;
  FULLNODE_RPC_ORIGINS?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  HEALTH_CHECKS_SYNC_SECRET?: string;
  METAGRAPH_ALLOW_R2_STATIC_FALLBACK?: string;
  METAGRAPH_D1_TIMEOUT_MS?: string;
  METAGRAPH_DISABLE_REQUEST_LOGS?: string;
  METAGRAPH_HEALTH_MAX_AGE_HOURS?: string;
  METAGRAPH_ICON_ALLOWED_HOSTS?: string;
  METAGRAPH_R2_TIMEOUT_MS?: string;
  METAGRAPH_WEBHOOK_SUBSCRIPTION_TOKEN?: string;
  NEURON_DAILY_BACKFILL_SECRET?: string;
  NEURONS_SYNC_SECRET?: string;
  NOMINATOR_POSITIONS_SYNC_SECRET?: string;
  POSTHOG_HOST?: string;
  POSTHOG_PROJECT_TOKEN?: string;
  REGISTRY_SYNC_SECRET?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_ADDRESS?: string;
  ROLLUP_SYNC_SECRET?: string;
  RPC_USAGE_SYNC_SECRET?: string;
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  SENTRY_RELEASE?: string;
  SUBNET_HYPERPARAMS_SYNC_SECRET?: string;
  SUBNET_IDENTITY_SYNC_SECRET?: string;
  SUBNET_LOCKS_SYNC_SECRET?: string;
  SUBNET_SNAPSHOT_SYNC_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
  UNKEY_ROOT_KEY?: string;
  VALIDATOR_NOMINATOR_COUNTS_SYNC_SECRET?: string;
  WALLET_SESSION_SECRET?: string;
}
