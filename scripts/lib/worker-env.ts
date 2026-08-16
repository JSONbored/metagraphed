// Typed partial envs for the per-Worker entrypoints (#11339).
//
// Lives under scripts/lib so BOTH the suites and the validator scripts can
// import it: `scripts/validate-api.ts` and friends drive the same Worker
// handlers a test does, and were building the same fake env with the same
// `as unknown as Env` -- 24 of them, each free to name a different type.
//
// Each Worker's env is now its OWN generated bindings plus the concerns
// workers/env-extra.d.ts assigns it, rather than the single merged `Env` every
// generated file used to declare. That is the point: referencing a binding this
// Worker does not have is a type error now, not a runtime `undefined` (#10186).
//
// It also means a suite can no longer hand a handler `{} as unknown as Env` --
// `Env` is the MAIN Worker's env, and passing it to a data-api handler is
// exactly the confusion the split exists to catch.
//
// ONE CAST, HERE. A test fixture cannot satisfy a real `DataApiEnv` -- it
// declares live platform bindings (a KVNamespace, a Hyperdrive, a Queue, a
// Durable Object namespace) that only the runtime can construct, and a suite
// supplies stubs for the two or three its route actually touches. So the cast
// is real; what was wrong was having it at 55 call sites, each free to name a
// different type.
//
// The parameter is keyed on the real env but valued `unknown`: a binding NAME
// that this Worker does not have is still a type error -- which is the half
// that catches the #10186 class -- while a hand-rolled stub standing in for a
// live binding is allowed, which is the half a suite needs. `Partial<Env>`
// would fail that second half, since it keeps each present key's full platform
// type.
import type {
  ApiWorkerEnv,
  DataApiWorkerEnv,
  RegistrySyncWorkerEnv,
} from "../../workers/types.ts";

/** Every binding this Worker has, each optional and each free to be a stub. */
export type EnvStub<T> = { [K in keyof T]?: unknown };

/** A partial `DataApiEnv` for a suite driving data-api's handlers. */
export function dataApiEnv(
  overrides: EnvStub<DataApiWorkerEnv> = {},
): DataApiWorkerEnv {
  return overrides as DataApiWorkerEnv;
}

/** A partial `RegistrySyncApiEnv`. */
export function registrySyncEnv(
  overrides: EnvStub<RegistrySyncWorkerEnv> = {},
): RegistrySyncWorkerEnv {
  return overrides as RegistrySyncWorkerEnv;
}

/** A partial `Env` -- the MAIN API Worker's, not any other's. */
export function apiEnv(overrides: EnvStub<ApiWorkerEnv> = {}): ApiWorkerEnv {
  return overrides as ApiWorkerEnv;
}
