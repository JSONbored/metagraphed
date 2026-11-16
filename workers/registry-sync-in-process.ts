// The REGISTRY_SYNC_API seam, served in-process (#13143, epic #13142).
//
// Same shape and same reasoning as workers/data-api-in-process.ts: the main
// Worker reaches the registry-sync write tier through the REGISTRY_SYNC_API
// service binding, and this adapter answers the binding's exact contract by
// dispatching into workers/registry-sync-api.ts's own handler in the same
// isolate. Nothing constructs it while the binding exists; the cutover config
// change makes it live.
//
// The write tier's auth gate travels with it untouched: the secret check lives
// inside dispatchRegistrySyncRequest, not in the binding, so in-process
// dispatch presents the identical 401/403/503 surface.
//
// WHAT DOES NOT FOLD: this Worker's one cron, the self-health probe (#10194).
// It runs on the registry-sync Worker precisely because that Worker does not
// serve api.metagraph.sh — a Worker cannot fetch its own custom domain, so the
// probe folded into the main Worker would 522 against a healthy API, which is
// the exact failure #10194 fixed. The cutover must move the probe somewhere
// that is not the thing being measured (the fleet job runner is the obvious
// home — #13150), not into this adapter.
import registrySyncApi from "./registry-sync-api.ts";
import type { MergedWorkerEnv, RegistrySyncWorkerEnv } from "./types.ts";

/** The merged single-Worker env: the main Worker's plus the write tier's. */
export type MergedRegistrySyncEnv = MergedWorkerEnv<RegistrySyncWorkerEnv>;

/** A REGISTRY_SYNC_API-shaped Fetcher that serves the write tier in-process. */
export function inProcessRegistrySyncApi(env: MergedRegistrySyncEnv): {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
} {
  return {
    fetch: (input, init) =>
      registrySyncApi.fetch(new Request(input, init), env),
  };
}
