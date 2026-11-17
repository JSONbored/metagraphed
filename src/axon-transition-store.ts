// The axon-transition capability as the serving environment sees it (#13019
// slice 2, consumers half).
//
// Both axon consumers -- the announcement watchdog and the removals loader --
// already choose between a native D1 store and the portable Neon reader. This
// adds the composed-tree arm in the same shape, so the choice stays one
// `selected*` call per consumer rather than a dialect branch inside the
// readers' own logic.
//
// The capability is deliberately a QUERY RUNNER plus the two guards, not a
// per-question method set: the questions are built from the shared sequence
// definition in src/axon-transition.ts, and a store that answered them itself
// would be a second place where "a UID lost a reachable axon" is decided --
// the exact drift that module exists to prevent.
import type { PgAxonTransitionStore } from "./axon-transition-pg.ts";

export type AxonTransitionStore = PgAxonTransitionStore;

const REQUIRED = ["query", "projectionReady", "assertReadable"] as const;

/**
 * The bound composed-tree axon store, or null when the serving environment has
 * none (the D1 and Neon paths stay unchanged in that case).
 *
 * An incomplete binding THROWS rather than returning null: a partially shaped
 * capability means a wiring defect, and falling back silently would answer
 * axon questions from a different store than the one the deployment selected.
 */
/**
 * The binding really is the capability -- a type predicate, so the selector
 * returns it without an assertion.
 *
 * The sibling `selected*Store` helpers in this tree assert instead. Narrowing
 * is the same check with the compiler holding the result, which is what makes
 * the `return` below safe rather than merely declared safe.
 */
function isAxonTransitionStore(value: unknown): value is AxonTransitionStore {
  return (
    typeof value === "object" &&
    value !== null &&
    REQUIRED.every((name) => typeof Reflect.get(value, name) === "function")
  );
}

export function selectedAxonTransitionStore(
  env: unknown,
): AxonTransitionStore | null {
  if (!env || typeof env !== "object" || !("AXON_TRANSITION_STORE" in env))
    return null;
  const store = env.AXON_TRANSITION_STORE;
  if (!isAxonTransitionStore(store))
    throw new TypeError("Native axon transition capability is incomplete");
  return store;
}
