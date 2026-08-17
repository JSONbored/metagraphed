// Reading a scheduled-projection artifact, ONCE (#11418).
//
// ## What this replaces
//
// Nineteen readers under `src/*-artifact.ts` opened with the same twenty
// lines: cast `env` to reach the bucket, fetch the key, cast the JSON body,
// check `schema_version`, check `windows`, resolve the window label against
// the route's set, cast the window cell, check `rows` is an array. Twenty-three
// files declared their own `interface ArtifactBucket` -- the same four tokens,
// twenty-three times -- and twenty-one wrote the identical
// `(env as { METAGRAPH_ARCHIVE?: ArtifactBucket } | null)` to get past a
// generated type that already declares `METAGRAPH_ARCHIVE: R2Bucket`.
//
// That cast was never about the binding being uncertain. It was there to
// WEAKEN a correct generated type so a `{ get }` test double would fit, and it
// took the real type's guarantees down with it for production callers too. The
// structural interface below is the honest spelling of the same intent: the
// narrow surface this module actually uses, which `R2Bucket` satisfies and a
// double can implement.
//
// ## The decline contract, in one place
//
// Every branch here returns null, and null means "this tier cannot answer
// FAITHFULLY" -- unbound binding, missing object, a body that is not what the
// lane wrote, or a window the lane did not precompute. The caller falls to its
// next tier. Never approximate, and in particular never answer one window with
// a DIFFERENT window's numbers, which is the specific defect the label check
// exists to prevent.
//
// Parsing is `schemas-src/projection-artifact.ts`'s job; this owns only the
// I/O and the tier decision.
import type { z } from "zod";

import { ProjectionEnvelopeSchema } from "../schemas-src/projection-artifact.ts";
import { type ChainNetworkId, projectionKey } from "./chain-network.ts";

/**
 * The narrow slice of `R2Bucket` a projection read uses.
 *
 * Structural on purpose: `R2Bucket` satisfies it, so production passes the
 * real binding with nothing erased, and a test double satisfies it without the
 * suite having to fake an entire bucket.
 */
export interface ArtifactObjectStore {
  get(key: string): Promise<{ json(): Promise<unknown> } | null>;
}

/**
 * The archive bucket, or null when nothing usable is bound.
 *
 * The runtime check is NOT redundant with the generated type. `Env` promises
 * the binding, but this module is also reached from tests, from scripts run
 * outside a Worker, and from a `wrangler dev` session whose config omitted the
 * bucket -- all places where the promise is not kept and a thrown TypeError
 * would surface as a 500 instead of a tier fallthrough.
 */
/**
 * An env that MAY carry the archive.
 *
 * Structural, and `Partial`, for two reasons. Several callers here type their
 * env narrowly on purpose -- `ContainerLaneWatchdogEnv` and
 * `R2SqlEnv` declare only the bindings they touch -- and demanding the whole
 * generated `Env` would push every one of them back to a cast. And a binding
 * present but not usable is a real runtime state, so the guard below is what
 * turns "maybe" into "yes" rather than an assertion (#11339's spelling).
 */
export interface ArtifactStoreEnv {
  METAGRAPH_ARCHIVE?: Partial<ArtifactObjectStore>;
}

function isReadable(
  bucket: Partial<ArtifactObjectStore> | null | undefined,
): bucket is ArtifactObjectStore {
  return typeof bucket?.get === "function";
}

export function artifactBucket(
  env: ArtifactStoreEnv | null | undefined,
): ArtifactObjectStore | null {
  const bucket = env?.METAGRAPH_ARCHIVE;
  return isReadable(bucket) ? bucket : null;
}

/**
 * The narrow slice of `R2Bucket` a projection WRITE uses.
 *
 * Separate from the read store rather than one interface with both methods,
 * because the split is what lets a reader's test double be a `get` and nothing
 * else -- and, more importantly, what stops a read path from acquiring a
 * `put` it should never call.
 */
export interface ArtifactWriteStore {
  put(key: string, value: string): Promise<unknown>;
}

export interface ArtifactWriteEnv {
  METAGRAPH_ARCHIVE?: Partial<ArtifactWriteStore>;
}

function isWritable(
  bucket: Partial<ArtifactWriteStore> | null | undefined,
): bucket is ArtifactWriteStore {
  return typeof bucket?.put === "function";
}

/** The archive bucket for writing, or null when nothing usable is bound. */
export function artifactWriteBucket(
  env: ArtifactWriteEnv | null | undefined,
): ArtifactWriteStore | null {
  const bucket = env?.METAGRAPH_ARCHIVE;
  return isWritable(bucket) ? bucket : null;
}

/**
 * Fetch one projection object and parse it, or decline.
 *
 * The `catch` covers the whole read: a bucket that throws, a body that is not
 * JSON, and a schema that rejects are the same answer to the caller -- this
 * tier cannot answer -- and none of them should reach a builder.
 */
export async function readArtifactObject<T>(
  env: Env | null | undefined,
  key: string,
  network: ChainNetworkId,
  schema: z.ZodType<T>,
): Promise<T | null> {
  const bucket = artifactBucket(env);
  if (!bucket) return null;
  try {
    const object = await bucket.get(projectionKey(key, network));
    if (!object) return null;
    const parsed = schema.safeParse(await object.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** What a windowed read resolved to: the label it served, and that cell. */
export interface ProjectionWindowRead<T> {
  /**
   * The label actually served -- the caller's, or the route's default when it
   * asked for none. Returned rather than recomputed because the builders stamp
   * it onto the response, and a reader that resolved the default twice could
   * serve one window's rows under another's name.
   */
  label: string;
  cell: T;
  /**
   * When the LANE computed this, or null when it stored no timestamp.
   *
   * Surfaced because a card that reports its own freshness lets a stalled lane
   * read as stale; a reader that substituted "now" here would publish a frozen
   * projection as current.
   */
  generatedAt: string | null;
}

export interface ProjectionWindowQuery<T> {
  /** Unprefixed R2 key; `projectionKey` applies the network prefix. */
  key: string;
  network: ChainNetworkId;
  /** The caller's requested window, if any. */
  window: string | null | undefined;
  /** The route's own default, used when the caller asked for none. */
  defaultWindow: string;
  /**
   * The ROUTE's window set, keyed by label.
   *
   * Checked before the artifact is consulted: a label outside this set is the
   * caller asking for something the route does not publish, which is a decline
   * regardless of what the lane happens to have stored.
   */
  windows: Readonly<Record<string, unknown>>;
  /** This lane's cell shape. */
  cell: z.ZodType<T>;
}

/**
 * Read one window out of a projection artifact.
 *
 * Returns null when the artifact cannot answer the asked-for window -- which
 * includes the window being absent from the stored set, because a lane that
 * has not computed 30d yet must not have its 7d numbers published as 30d.
 */
export async function readProjectionWindow<T>(
  env: Env | null | undefined,
  query: ProjectionWindowQuery<T>,
): Promise<ProjectionWindowRead<T> | null> {
  const label = query.window ?? query.defaultWindow;
  if (!Object.hasOwn(query.windows, label)) return null;
  const envelope = await readArtifactObject(
    env,
    query.key,
    query.network,
    ProjectionEnvelopeSchema,
  );
  if (!envelope) return null;
  if (!Object.hasOwn(envelope.windows, label)) return null;
  const cell = query.cell.safeParse(envelope.windows[label]);
  if (!cell.success) return null;
  return { label, cell: cell.data, generatedAt: envelope.generated_at ?? null };
}
