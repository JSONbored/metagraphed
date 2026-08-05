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
  /** #9208: gates POST /api/v1/internal/chain-detail-sync and its head GET --
   * the live-follow decode lane's write path into the chain-detail hot tier.
   * Set via `wrangler secret put` on BOTH Workers (api.ts proxies, data-api.ts
   * checks) and on the producer side in metagraphed-infra. */
  CHAIN_DETAIL_SYNC_SECRET?: string;
  /** #9208: overrides CHAIN_DETAIL_STALENESS_THRESHOLD_MS for the hot-tier
   * watchdog, so the alarm can be widened during a known outage without a
   * deploy. Unset means the module's own 20-minute default. */
  CHAIN_DETAIL_STALENESS_THRESHOLD_MS?: string;
  CHAIN_FIREHOSE_SYNC_SECRET?: string;
  /** #8748/#8750 restored lane: gates POST /api/v1/internal/emission-gate-sync,
   * the D1 write path the sample-emission-gate.yml schedule POSTs chain
   * readings to. Set via `wrangler secret put` AND as a GitHub Actions secret
   * (the workflow sends it; the Worker checks it). */
  EMISSION_GATE_SYNC_SECRET?: string;
  /** RPC endpoint for the Worker-cron emission-gate sampler; falls back to
   * CHAIN_HEAD_RPC_URL and then the public archive endpoint. */
  EMISSION_SAMPLER_RPC_URL?: string;
  EMISSION_DRIFT_RPC_URL?: string;
  LIVE_ALERT_WEBHOOK_URL?: string;
  /** RPC endpoint for the Worker-cron live-economics refresh
   * (src/live-economics-refresh.ts); falls back to CHAIN_HEAD_RPC_URL and then
   * the public archive endpoint, matching the sampler and drift-check lanes. */
  LIVE_ECONOMICS_RPC_URL?: string;
  FULLNODE_RPC_ORIGINS?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  /** Authenticates the daily github-signals cron's ~476 GitHub reads
   * (src/github-signals-sync.ts) -- a fine-grained PAT with public-repo
   * read-only metadata access, set via `wrangler secret put
   * GITHUB_SIGNALS_TOKEN`. Its OWN secret rather than sharing GITHUB_TOKEN
   * below: the radar deliberately tolerates running unauthenticated (it
   * reports null upstreams when throttled), while this lane must NOT -- an
   * unauthenticated capture would mass-`unreachable` the published artifact,
   * so an unset token here is a loud no-op, never a degraded run. */
  GITHUB_SIGNALS_TOKEN?: string;
  /** #8702: authenticates the upgrade radar's twice-hourly GitHub reads
   * (releases + BITs). Unauthenticated GitHub allows 60 requests/hour per IP
   * against Cloudflare's SHARED egress addresses -- a budget we neither
   * control nor have to ourselves -- so an unset token here is a real
   * degradation, not a neutral default. Set via `wrangler secret put`; the
   * radar still runs without it and simply reports null upstreams when
   * GitHub throttles. */
  GITHUB_TOKEN?: string;
  /**
   * #8600: Ethereum MAINNET JSON-RPC endpoint for the TAO/USD index (ADR
   * 0025). Mainnet specifically -- every pool ADR 0025 names is Uniswap v3 on
   * Ethereum L1, not an L2.
   *
   * A SECRET, not a var, and with no committed default. Two separate reasons,
   * and both matter:
   *
   * SECRET, because the credential IS the URL. Providers whose terms permit
   * programmatic access authenticate by embedding the key in the path
   * (https://eth-mainnet.g.alchemy.com/v2/<key>), so there is no version of
   * this that is safe to put in `vars`.
   *
   * NO DEFAULT, because every free public endpoint surveyed carries blanket
   * "no scraping / no derivative works" terms -- the same clauses that ruled
   * out the CEX basis in ADR 0025. Which endpoint we accept terms with is an
   * ops decision, not a repo constant. Note this inverts the CEX finding: for
   * an exchange a key made things worse (it meant accepting a redistribution
   * ban), while for an RPC provider a key makes them better, because selling
   * programmatic access IS the product.
   *
   * Unset, the ingestion tick is a recorded no-op -- never a silent fallback
   * to some other provider's node.
   */
  ETH_RPC_URL?: string;
  HEALTH_CHECKS_SYNC_SECRET?: string;
  /** #9502: gates POST /api/v1/internal/hotkey-alpha-sync -- the write path
   * into hotkey_alpha, the (hotkey, netuid) alpha-pool totals delegated_tao
   * values a position against.
   *
   * ONE Worker, not two: `wrangler secret put HOTKEY_ALPHA_SYNC_SECRET --name
   * metagraphed-data-api`. api.ts only PROXIES this route -- it forwards the
   * caller's header untouched and never reads the secret itself -- so setting
   * it there does nothing. (The sibling comments above say "BOTH Workers"
   * because their routes are checked in both; this one is not.)
   *
   * The producer needs the SAME value as `hotkey_alpha_sync_secret` in the
   * metagraphed-infra vault. It is a shared secret with no external issuer:
   * any high-entropy random string works, and until both sides hold it the
   * poller logs "job will not run" rather than failing quietly. */
  HOTKEY_ALPHA_SYNC_SECRET?: string;
  POLLER_LANE_HEALTH_SYNC_SECRET?: string;
  METAGRAPH_ALLOW_R2_STATIC_FALLBACK?: string;
  METAGRAPH_DISABLE_REQUEST_LOGS?: string;
  METAGRAPH_HEALTH_MAX_AGE_HOURS?: string;
  METAGRAPH_ICON_ALLOWED_HOSTS?: string;
  METAGRAPH_R2_TIMEOUT_MS?: string;
  METAGRAPH_WEBHOOK_SUBSCRIPTION_TOKEN?: string;
  /**
   * #9009: AES-256-GCM key material (via SHA-256) for the MCP
   * surface-credential store (src/mcp-surface-credentials.ts). These are
   * third-party secrets belonging to the CALLER, not to us, so KV holds only
   * ciphertext -- a KV snapshot without this secret yields nothing.
   *
   * Unset, the store refuses every operation with a typed
   * `surface_credential_store_unavailable` rather than degrading to plaintext
   * or silently accepting a credential it cannot persist. Rotating it
   * invalidates every stored registration (they become undecryptable and read
   * as absent), which is the intended blast radius for a key rotation.
   */
  MCP_SURFACE_CREDENTIAL_SECRET?: string;
  NEURON_DAILY_BACKFILL_SECRET?: string;
  NEURONS_SYNC_SECRET?: string;
  NOMINATOR_POSITIONS_SYNC_SECRET?: string;
  POSTHOG_EXCEPTION_STORM_WINDOW_MS?: string;
  POSTHOG_HOST?: string;
  POSTHOG_PROJECT_TOKEN?: string;
  POSTHOG_TRACES_SAMPLE_RATE?: string;
  POSTHOG_TRACES_SAMPLE_RATE_MCP?: string;
  POSTHOG_USAGE_SAMPLE_RATE?: string;
  POSTHOG_USAGE_SAMPLE_RATES?: string;
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

// #204 head poller (ChainFirehoseHub.alarm) -- vars are optional so local/CI
// (no wrangler vars) type-checks; the kill switch defaults to off.
interface Env {
  CHAIN_HEAD_POLL_ENABLED?: string;
  CHAIN_HEAD_RPC_URL?: string;
  CHAIN_HEAD_POLL_INTERVAL_MS?: string;
  /** #9417: read each block's event count from System.Events' SCALE length
   * prefix. Defaults ON (only "false" disables) -- unlike the poll switch
   * above, the feature it gates is a correctness fix, so an unset var in
   * local/CI should exercise it rather than skip it. */
  CHAIN_HEAD_EVENT_COUNT_ENABLED?: string;
  /** #9455: derive each block's author from the header's Aura pre-runtime
   * digest plus the Aura.Authorities set. Defaults ON (only "false" disables),
   * for the same reason as the count above — it fills a field that otherwise
   * publishes null for the whole head window. Separate from the count switch so
   * either extra storage read can be dropped without the other. */
  CHAIN_HEAD_AUTHOR_ENABLED?: string;
  /** #8700: the raw-capture lane's testnet endpoint. Only the capture lane
   * reads it — the head poller stays mainnet-only, because `blocks_head` has
   * no network dimension yet. */
  TESTNET_CHAIN_HEAD_RPC_URL?: string;
}

// Raw chain capture (src/raw-chain-capture.ts). Kill switch is opt-IN: an
// unset value means the lane does not run, so a deploy can never start
// capturing before the migration that creates its watermark table.
interface Env {
  RAW_CAPTURE_ENABLED?: string;
  /** R2 SQL read tier over the chain lakehouse (src/r2-sql.ts). Token is a
   * wrangler secret; account/warehouse fall back to this account's values and
   * are only set when pointing at a different warehouse. */
  R2_SQL_TOKEN?: string;
  R2_SQL_ACCOUNT_ID?: string;
  R2_SQL_WAREHOUSE?: string;
  R2_SQL_RATE_LIMIT_COOLDOWN_MS?: string;
}

// RPC reverse-proxy usage telemetry on Workers Analytics Engine (#9228).
//
// The WRITE binding is declared in wrangler.jsonc and needs no secret. The
// READ path is a separate Cloudflare API token with the
// `Account | Account Analytics | Read` scope, which is the only scope the AE
// SQL API accepts -- so it is a genuinely new credential, not a reuse of
// R2_SQL_TOKEN (different product, different permission). Optional because a
// deployment without it must still type-check and still serve: the hot tier
// declines and /api/v1/rpc/usage falls through to the lakehouse cold tier.
interface Env {
  RPC_USAGE_ANALYTICS?: AnalyticsEngineDataset;
  /** `npx wrangler secret put ANALYTICS_ENGINE_SQL_TOKEN` */
  ANALYTICS_ENGINE_SQL_TOKEN?: string;
  ANALYTICS_ENGINE_SQL_ACCOUNT_ID?: string;
  /** Override for the capture-staleness alarm's threshold, in ms. Unset uses
   * the measured RPC_USAGE_STALENESS_THRESHOLD_MS default. */
  RPC_USAGE_STALENESS_THRESHOLD_MS?: string;
}
