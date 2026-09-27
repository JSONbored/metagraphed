// Projection I/O and ownership. A declined read returns null; never substitute
// another window or fabricate freshness. Schemas own payload validation.
import type { z } from "zod";

import { ProjectionEnvelopeSchema } from "../schemas-src/projection-artifact.ts";
import { type ChainNetworkId, projectionKey } from "./chain-network.ts";
import {
  isNativeProjectionKey,
  nativeProjectionsEnabled,
  readNativeProjectionObject,
} from "./native-projection-store.ts";

/** Structural projection read port, shared by D1 and archive adapters. */
export interface ArtifactObjectStore {
  get(
    key: string,
  ): Promise<{ json(): Promise<unknown>; etag?: string; size?: number } | null>;
}

/** Optional bindings are checked at runtime, including untyped history-reader D1 ports. */
export interface ArtifactStoreEnv {
  NATIVE_PROJECTIONS?: string;
  D1_STATE?: unknown;
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

/** Separate write port: read-only callers cannot acquire writes. */
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

/** Read the selected owner and validate its payload; failures decline the tier. */
export async function readArtifactObject<T>(
  env: ArtifactStoreEnv | null | undefined,
  key: string,
  network: ChainNetworkId,
  schema: z.ZodType<T>,
): Promise<T | null> {
  try {
    if (nativeProjectionsEnabled(env) && isNativeProjectionKey(key)) {
      const body = await readNativeProjectionObject(env!, key, network);
      const parsed = schema.safeParse(body);
      return parsed.success ? parsed.data : null;
    }
    const bucket = artifactBucket(env);
    if (!bucket) return null;
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
  /** Actual served label, including the route default. */
  label: string;
  cell: T;
  /** Producer timestamp, never replaced with the reader clock. */
  generatedAt: string | null;
}

export interface ProjectionWindowQuery<T> {
  /** Exact native module scope, selected before parsing the window cell. */
  callModule?: string | null;
  /** Logical key; `projectionKey` applies the network prefix. */
  key: string;
  network: ChainNetworkId;
  /** The caller's requested window, if any. */
  window: string | null | undefined;
  /** The route's own default, used when the caller asked for none. */
  defaultWindow: string;
  /** Supported route windows; reject any other label before reading storage. */
  windows: Readonly<Record<string, unknown>>;
  /** This lane's cell shape. */
  cell: z.ZodType<T>;
}

/** Read the exact requested window; absent windows decline instead of substituting data. */
export async function readProjectionWindow<T>(
  env: ArtifactStoreEnv | null | undefined,
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
  let windows = envelope.windows;
  if (typeof query.callModule === "string" && query.callModule.length > 0) {
    if (!envelope.module_windows || !envelope.empty_module_windows) return null;
    windows =
      envelope.module_windows.find((entry) => entry.module === query.callModule)
        ?.windows ?? envelope.empty_module_windows;
  }
  if (!Object.hasOwn(windows, label)) return null;
  const cell = query.cell.safeParse(windows[label]);
  if (!cell.success) return null;
  return { label, cell: cell.data, generatedAt: envelope.generated_at ?? null };
}
