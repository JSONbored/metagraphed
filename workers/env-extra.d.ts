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
  /** #8611: gates the key-level block/unblock/anomaly routes. Its OWN secret --
   * cutting off a paying customer is a higher-privilege act than recording a
   * request, so it never shares the key-verify token. */
  API_KEY_BLOCK_INTERNAL_TOKEN?: string;
  ALERT_TRIGGER_CREATE_TOKEN?: string;
  ALERT_TRIGGERS_INTERNAL_TOKEN?: string;
  API_KEY_LOOKUP_INTERNAL_TOKEN?: string;
  CHAIN_FIREHOSE_SYNC_SECRET?: string;
  FULLNODE_RPC_ORIGINS?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  /** #8702: authenticates the upgrade radar's twice-hourly GitHub reads
   * (releases + BITs). Unauthenticated GitHub allows 60 requests/hour per IP
   * against Cloudflare's SHARED egress addresses -- a budget we neither
   * control nor have to ourselves -- so an unset token here is a real
   * degradation, not a neutral default. Set via `wrangler secret put`; the
   * radar still runs without it and simply reports null upstreams when
   * GitHub throttles. */
  GITHUB_TOKEN?: string;
  /**
   * #8600: Ethereum JSON-RPC endpoint for the TAO/USD index (ADR 0025).
   *
   * A deploy-time binding with NO committed default, deliberately. Every free
   * public endpoint surveyed carries blanket "no scraping / no derivative
   * works" terms -- the same clauses that ruled out the CEX basis -- so which
   * endpoint we accept terms with is an ops decision, not a repo constant.
   * Unset means the ingestion tick is a recorded no-op, never a fallback to
   * some other provider's node.
   */
  ETH_RPC_URL?: string;
  HEALTH_CHECKS_SYNC_SECRET?: string;
  METAGRAPH_ALLOW_R2_STATIC_FALLBACK?: string;
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
  POSTHOG_TRACES_SAMPLE_RATE?: string;
  REGISTRY_SYNC_SECRET?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_ADDRESS?: string;
  ROLLUP_SYNC_SECRET?: string;
  RPC_USAGE_SYNC_SECRET?: string;
  SUBNET_HYPERPARAMS_SYNC_SECRET?: string;
  SUBNET_IDENTITY_SYNC_SECRET?: string;
  SUBNET_LOCKS_SYNC_SECRET?: string;
  SUBNET_SNAPSHOT_SYNC_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
  UNKEY_ROOT_KEY?: string;
  // #8385 web-push (VAPID, RFC 8292). Ops-managed Worker secrets — the KEY
  // VALUES never live in this repo. All three are required together; the
  // webpush channel degrades to a recorded delivery failure when any is
  // absent, exactly like TELEGRAM_BOT_TOKEN/RESEND_API_KEY above.
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  /** RFC 8292 §2.1 contact: `mailto:` or `https:`. */
  VAPID_SUBJECT?: string;
  VALIDATOR_NOMINATOR_COUNTS_SYNC_SECRET?: string;
  WALLET_SESSION_SECRET?: string;
  WATCH_TRIGGER_TOKEN_SECRET?: string;
}
