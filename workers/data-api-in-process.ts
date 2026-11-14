// The DATA_API seam, served in-process (#13143).
//
// The main Worker reaches the data tier through the DATA_API service binding —
// a Fetcher whose whole contract is Request in, Response out. The 2-Worker
// consolidation (#13142, #13143) folds the data tier into the main Worker, and
// this module is the fold: the identical contract, dispatched into
// workers/data-api.ts's own handler in the same isolate instead of across a
// service binding.
//
// NOTHING CONSTRUCTS THIS while the DATA_API binding exists, so today it
// changes no behavior and no bundle: only the cutover config change — which
// removes the binding from wrangler.jsonc, merges the data tier's bindings and
// secrets in, and wires the entry to fall back to this adapter — makes it
// live. That ordering is deliberate: it turns the Worker merge into a config
// flip that one deploy applies and one deploy rolls back, rather than a code
// change entangled with a deploy.
//
// The env is the INTERSECTION of both Workers' envs, not either one alone. The
// data tier's handlers read bindings the main Worker also has (D1_STATE,
// METAGRAPH_CONTROL, the history-shard services) plus members only its own
// config declares today (UNKEY_API_ID, SYNC_BATCHES, its rate limiters, its
// sync secrets). A merged deployment carries both sets; the type says so, and
// a call site that cannot produce both sets cannot construct the adapter.
import dataApi from "./data-api.ts";
import type { AppExecutionContext } from "./runtime-context.ts";
import type { ApiWorkerEnv, DataApiWorkerEnv } from "./types.ts";

/** The merged single-Worker env: the main Worker's plus the data tier's. */
export type MergedDataApiEnv = ApiWorkerEnv & DataApiWorkerEnv;

/**
 * A DATA_API-shaped Fetcher that serves the data tier in-process.
 *
 * Accepts exactly what a service binding's `fetch` accepts, so every one of
 * api.ts's `env.DATA_API.fetch(...)` call sites works against it unchanged.
 */
export function inProcessDataApi(
  env: MergedDataApiEnv,
  ctx: AppExecutionContext,
): { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> } {
  return {
    fetch: (input, init) => dataApi.fetch(new Request(input, init), env, ctx),
  };
}
