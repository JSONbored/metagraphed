import { registerModuleStateReset } from "../src/module-state-registry.ts";
// One shared buffer for both the complete router and the default directories.
import {
  foldObservations,
  observeRequest,
  type UsageObservation,
  type RouteMatcher,
} from "../src/usage-rollup.ts";
import { API_KEY_LOOKUP_TOKEN_HEADER } from "../src/api-key-validation.ts";
type Ctx = { waitUntil?: (promise: Promise<unknown>) => void };
// Fire-and-forget ALL-TRAFFIC usage rollup (#8597) -- keyed and keyless alike.
//
// Distinct from recordApiKeyUsage below, which it does not replace: that one is
// per-account and only fires for requests presenting a key, powering the tenant
// dashboard. This one has no account dimension and fires for EVERY API request,
// because keyless traffic is the majority by design and is the entire subject
// of the "does the free tier cost too much" question ADR 0022 defers.
//
// Same posture as recordApiKeyUsage: ctx.waitUntil so it adds no latency, and
// it swallows its own failure -- a rollup miss must never surface as an error
// on the actual API call.
// #8823: observations are BUFFERED in the isolate and flushed in batches.
//
// Until this landed, foldObservations was handed a single-element array on
// every request, so N requests meant N DATA_API subrequests, N postgres()
// clients (withAccountsSql builds a fresh one per invocation), and N upserts
// -- and a flood of `/api/v1/<random>` 404s all collapse to the single
// (day, "unmatched", "edge") row, so those N upserts serialised on one row
// lock against a self-hosted database whose capacity is ours. Nothing
// throttles that path: /api/* is run_worker_first and the generic 404 is
// reached without passing any of the per-surface limiters.
//
// The flush triggers are count-OR-age, evaluated synchronously as each
// observation arrives (Workers has no timer that runs outside a request, so
// the age check can only fire when a LATER request arrives -- which is
// exactly when a flush is affordable). Both bounds are deliberately small:
// they cap what an isolate can lose on eviction, which is the one accuracy
// cost of buffering.
const USAGE_ROLLUP_FLUSH_COUNT = 64;

const USAGE_ROLLUP_FLUSH_AGE_MS = 10_000;

let usageRollupBuffer: UsageObservation[] = [];

let usageRollupBufferedAtMs = 0;

// Exported for the tests that assert the batching property; not part of any
// route's behaviour.
export function usageRollupBufferSize(): number {
  return usageRollupBuffer.length;
}

// Drain the buffer into ONE subrequest carrying every folded bucket. Drains
// before the fetch so a concurrent request in the same isolate cannot send
// the same observations twice. A failed POST loses that batch, the same
// best-effort posture the single-observation write already had -- a rollup
// miss must never surface on the API call that triggered it.
export function flushUsageRollup(env: Env, ctx: Ctx | undefined): void {
  if (usageRollupBuffer.length === 0) return;
  if (!env.DATA_API?.fetch || !env.API_KEY_LOOKUP_INTERNAL_TOKEN) return;
  const buckets = foldObservations(usageRollupBuffer);
  usageRollupBuffer = [];
  usageRollupBufferedAtMs = 0;
  const pending = env.DATA_API.fetch(
    new Request("https://api.metagraph.sh/api/v1/internal/usage-rollup", {
      method: "POST",
      headers: {
        [API_KEY_LOOKUP_TOKEN_HEADER]: env.API_KEY_LOOKUP_INTERNAL_TOKEN,
        "content-type": "application/json",
      },
      body: JSON.stringify({ buckets }),
    }),
  ).catch(() => {});
  if (typeof ctx?.waitUntil === "function") {
    ctx.waitUntil(pending);
  }
}

export function recordMatchedUsageRollup(
  env: Env,
  ctx: Ctx | undefined,
  pathname: string,
  keyed: boolean,
  matchers: readonly RouteMatcher[],
): void {
  if (!env.DATA_API?.fetch || !env.API_KEY_LOOKUP_INTERNAL_TOKEN) return;
  const observation = observeRequest(pathname, matchers, {
    keyed,
  });
  const nowMs = Date.now();
  if (usageRollupBuffer.length === 0) usageRollupBufferedAtMs = nowMs;
  usageRollupBuffer.push(observation);
  // A buffer spanning midnight needs no special case: each observation
  // carries its own `day` and foldObservations groups on it, so the batch
  // simply emits two buckets.
  if (
    usageRollupBuffer.length < USAGE_ROLLUP_FLUSH_COUNT &&
    nowMs - usageRollupBufferedAtMs < USAGE_ROLLUP_FLUSH_AGE_MS
  ) {
    return;
  }
  flushUsageRollup(env, ctx);
}

registerModuleStateReset("workers/usage-rollup.ts", () => {
  usageRollupBuffer = [];
  usageRollupBufferedAtMs = 0;
});
