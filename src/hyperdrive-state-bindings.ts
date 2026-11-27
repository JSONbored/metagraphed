// Hyperdrive-selected native state bindings (#13171, part of #13142).
//
// The Worker-side half of the storage seam: when a deployment says
// `METAGRAPH_STATE_SOURCE="hyperdrive"` AND binds HYPERDRIVE, the env's store
// keys are filled with the same binding family `createNativeStateBindings`
// builds for the native process — one pooled PostgreSQL runtime over the
// Hyperdrive connection string, the manifest's sources scoped over it, the
// pinned SQLite document decoder, and this module's default resource limits.
// Absent either input the env is returned UNCHANGED, so today's deploys (no
// HYPERDRIVE binding exists in any wrangler config, and no config sets the
// selector) see zero behavior change: D1 stays the default and this module is
// only ever loaded behind the selector (see workers/api.entry.ts).
//
// Lifecycle is deliberately NOT the native process's. Workers isolates have no
// shutdown hook to drain into, and real connection pooling belongs to
// Hyperdrive itself — the per-isolate pool here is only short-lived request
// fanout. Cleanup closures are still collected (the adapters require an
// owner), but nothing registers process hooks: an isolate's teardown discards
// the memoized runtime with the isolate.

import {
  createPgStoreRuntime,
  type PgStoreRuntime,
} from "./pg-store-runtime.ts";
import { scopedSource, type NativeSource } from "./native-api-process.ts";
import { nativeSourceDefinitions } from "./native-source-manifest.ts";
import { createSqliteDocumentDecoder } from "./sqlite-document-decoder.ts";
import {
  createNativeStateBindings,
  type NativeStateLimits,
} from "./native-state-bindings.ts";
import { registerModuleStateReset } from "./module-state-registry.ts";

interface HyperdriveStateSourceEnv {
  METAGRAPH_STATE_SOURCE?: string;
  HYPERDRIVE?: { connectionString?: unknown };
}

/** Initial dark-launch policy, inside every adapter's validated ceiling. The
 * fleet swap (#13142) revisits these with measured Hyperdrive numbers; they are
 * constants rather than env vars so a deployment cannot partially select the
 * seam. maxConnections stays at the validator-detail read fanout minimum the
 * native environment enforces (five concurrent independent reads). */
const HYPERDRIVE_POSTGRES = Object.freeze({
  maxConnections: 5,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 2000,
  statementTimeoutMillis: 10000,
});

const HYPERDRIVE_DECODER_MAX_AUDIT_BYTES = 1024 * 1024;

const HYPERDRIVE_STATE_LIMITS: NativeStateLimits = Object.freeze({
  capture: Object.freeze({
    maxRows: 10000,
    maxDocuments: 256,
    maxPayloadBytes: 16 * 1024 * 1024,
    maxConcurrent: 2,
    executionTimeoutMillis: 10000,
    drainTimeoutMillis: 5000,
  }),
  rpcUsage: Object.freeze({
    maxPending: 10000,
    maxPendingBytes: 16 * 1024 * 1024,
    batchSize: 500,
    retentionDays: 31,
    executionTimeoutMillis: 10000,
    drainTimeoutMillis: 5000,
  }),
  validatorHistory: Object.freeze({
    maxSourceRows: 200000,
    maxPageBytes: 32 * 1024 * 1024,
    pageRows: 512,
    maxDurationMillis: 20000,
  }),
});

interface HyperdriveStateEntry {
  bindings: ReturnType<typeof createNativeStateBindings>["bindings"];
  /** Collected for the adapters that demand an owner; never process-hooked. */
  cleanups: (() => unknown)[];
}

let stateByConnection = new Map<string, HyperdriveStateEntry>();
let environments = new WeakMap<object, object>();
registerModuleStateReset("src/hyperdrive-state-bindings.ts", () => {
  stateByConnection = new Map();
  environments = new WeakMap();
});

function hyperdriveStateEntry(connectionString: string): HyperdriveStateEntry {
  const existing = stateByConnection.get(connectionString);
  if (existing) return existing;
  // The connection's role is the declared owner of every schema. The manifest
  // separates the app and retained sources (distinct schemas, and on the fleet
  // eventually distinct databases), but Hyperdrive fronts ONE origin database,
  // so for now both scope over the same runtime; a later retained split gets
  // its own binding rather than a second meaning for this one.
  const owner = decodeURIComponent(new URL(connectionString).username);
  const definitions = nativeSourceDefinitions({
    app: owner,
    auth: owner,
    chain: owner,
    jobs: owner,
    realtime: owner,
    retained: owner,
    search: owner,
  });
  const cleanups: HyperdriveStateEntry["cleanups"] = [];
  const runtime: PgStoreRuntime = createPgStoreRuntime({
    connectionString,
    ...HYPERDRIVE_POSTGRES,
    onIdleError: console.error.bind(
      console,
      "Hyperdrive state source idle connection error:",
    ),
  });
  cleanups.push(runtime.close);
  const sources = new Map<string, NativeSource>(
    definitions.map((definition) => [
      definition.name,
      scopedSource(runtime, definition),
    ]),
  );
  const decoder = createSqliteDocumentDecoder({
    maxAuditBytes: HYPERDRIVE_DECODER_MAX_AUDIT_BYTES,
  });
  cleanups.push(decoder.close.bind(decoder));
  const state = createNativeStateBindings(
    sources,
    decoder,
    HYPERDRIVE_STATE_LIMITS,
    (cleanup) => {
      cleanups.push(cleanup);
    },
  );
  const entry: HyperdriveStateEntry = {
    bindings: state.bindings,
    cleanups,
  };
  stateByConnection.set(connectionString, entry);
  return entry;
}

/** Fill the env's store keys from the Hyperdrive-selected PostgreSQL state, or
 * return the env untouched when the deployment has not selected it. Memoized
 * per connection string (the stores and their pool are isolate-lifetime) and
 * per env object (a warm isolate's repeated requests share one wrapped env);
 * the input env is never mutated. */
export function withHyperdriveStateBindings<T extends object>(env: T): T {
  const config = env as HyperdriveStateSourceEnv;
  if (config.METAGRAPH_STATE_SOURCE !== "hyperdrive") return env;
  const connectionString = config.HYPERDRIVE?.connectionString;
  if (typeof connectionString !== "string" || connectionString === "")
    return env;
  const cached = environments.get(env);
  if (cached) return cached as T;
  const wrapped = {
    ...env,
    ...hyperdriveStateEntry(connectionString).bindings,
  };
  environments.set(env, wrapped);
  environments.set(wrapped, wrapped);
  return wrapped;
}
