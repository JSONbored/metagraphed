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
  ALERT_TRIGGERS_INTERNAL_TOKEN?: string;
  METAGRAPH_ALLOW_R2_STATIC_FALLBACK?: string;
  METAGRAPH_D1_TIMEOUT_MS?: string;
  METAGRAPH_DISABLE_REQUEST_LOGS?: string;
  METAGRAPH_R2_TIMEOUT_MS?: string;
  REGISTRY_SYNC_SECRET?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_ADDRESS?: string;
  RPC_USAGE_SYNC_SECRET?: string;
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  SENTRY_RELEASE?: string;
  TELEGRAM_BOT_TOKEN?: string;
}
