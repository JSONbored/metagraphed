// Storage + IO layer for the API Worker — artifact reads (R2 + static-asset
// tiers with fallback), the latest-pointer / health-KV reads, request logging,
// and the timeout guard that bounds R2 access. Extracted from workers/api.mjs
// (issue #510, de-monolith) as a leaf module: it imports only the artifact-tier
// contract and a config key, and calls nothing back into api.mjs, so handlers
// and the response builders can share it without an import cycle.
import {
  artifactStorageTierForPath,
  ARTIFACT_STORAGE_TIERS,
  isR2PreferredDualArtifactPath,
} from "../src/artifact-storage.ts";
import { METAGRAPH_LATEST_KEY } from "./config.ts";

const DEFAULT_R2_TIMEOUT_MS = 5000;

/**
 * How an R2 artifact key was resolved (#8287). Surfaced as a response header so
 * the read path's health is observable from OUTSIDE the Worker, with no log
 * access and no secrets — the same "read the live public signal" posture as
 * the publish-freshness alarm (#8286).
 *
 *  - `manifest` — resolved through the run's immutable manifest to a
 *    content-addressed by-hash key (#8277). The healthy steady state.
 *  - `prefix`   — resolved by concatenating the pointer's `latest_prefix`.
 *    Normal for a pointer written before #8277, and for artifacts the manifest
 *    does not name.
 *  - `fallback` — the resolved key held no object and the literal `latest/`
 *    retry saved the read (#8279). Correct behaviour, but it means the pointer
 *    is WRONG: every artifact read is paying a second round-trip. Acceptable
 *    as a burst mid-publish, never acceptable sustained.
 */
export type ArtifactResolution = "manifest" | "prefix" | "fallback";

export interface StorageReadOk {
  ok: true;
  data: unknown;
  source: "static-assets" | "r2";
  storage_tier: string;
  resolution?: ArtifactResolution;
}
export interface StorageReadError {
  ok: false;
  status: number;
  code: string;
  message: string;
}
export type StorageReadResult = StorageReadOk | StorageReadError;

export interface R2ObjectReadOk {
  ok: true;
  object: R2ObjectBody;
  source: "r2";
  storage_tier: string;
  resolution?: ArtifactResolution;
}
export type R2ObjectReadResult = R2ObjectReadOk | StorageReadError;

export interface LatestPointer {
  published_at?: string;
  latest_prefix?: string;
  /**
   * #8277: key of the immutable per-run FULL manifest (path -> content-addressed
   * by-hash key for every artifact the run published). Optional — a pointer
   * written before #8277, or by a partial publish, simply won't have it and
   * resolution falls back to `latest_prefix`.
   */
  full_manifest_run_key?: string;
}

interface RunManifestEntry {
  path?: string;
  key?: string;
}

/**
 * Per-run artifact index, memoized for the life of the isolate.
 *
 * No TTL, unlike `pointerMemo` below: a run manifest is IMMUTABLE (it lives at
 * `runs/<run>/r2-manifest.json` and is never rewritten), so once parsed for a
 * given key it can never go stale. A new publish changes the pointer's
 * `full_manifest_run_key`, which misses this cache by key and loads the new one.
 * `null` is cached too, so a manifest that failed to load doesn't re-fetch a
 * ~585 KB object on every subsequent request.
 */
const runManifestMemo = new Map<string, Map<string, string> | null>();

async function runManifestIndex(
  env: Env,
  manifestKey: string,
): Promise<Map<string, string> | null> {
  const cached = runManifestMemo.get(manifestKey);
  if (cached !== undefined) return cached;

  let index: Map<string, string> | null = null;
  try {
    const object = await withTimeout(
      env.METAGRAPH_ARCHIVE.get(manifestKey),
      r2TimeoutMs(env),
    );
    const body = object
      ? ((await object.json()) as { artifacts?: unknown })
      : null;
    const artifacts = Array.isArray(body?.artifacts)
      ? (body.artifacts as RunManifestEntry[])
      : null;
    if (artifacts) {
      index = new Map();
      for (const artifact of artifacts) {
        if (artifact?.path && artifact?.key) {
          index.set(artifact.path, artifact.key);
        }
      }
    }
  } catch {
    // Best-effort by design: a timeout, a malformed body, or a missing object
    // must degrade to latest_prefix resolution, never fail the read.
    index = null;
  }
  runManifestMemo.set(manifestKey, index);
  return index;
}

// Structured request logging on non-happy paths (R2 timeout, static fallback) so
// it does not spam logs. Disabled with METAGRAPH_DISABLE_REQUEST_LOGS=true.
export function logEvent(
  env: Env,
  level: string,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  if (env.METAGRAPH_DISABLE_REQUEST_LOGS === "true") {
    return;
  }
  try {
    console.log(JSON.stringify({ level, event, ...fields }));
  } catch {
    // Never let logging break a request.
  }
}

export function r2TimeoutMs(env: Env): number {
  const raw = Number(env.METAGRAPH_R2_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_R2_TIMEOUT_MS;
}

// R2's get() takes no AbortSignal, so bound it with a race: a slow/degraded
// bucket yields a controlled 504 (and static fallback where allowed) instead of
// hanging the request until the platform wall-clock limit.
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function readArtifact(
  env: Env,
  artifactPath: string,
): Promise<StorageReadResult> {
  const storageTier = artifactStorageTierForPath(artifactPath);

  if (storageTier === ARTIFACT_STORAGE_TIERS.r2) {
    const r2 = await readR2(env, artifactPath, storageTier);
    if (r2.ok || env.METAGRAPH_ALLOW_R2_STATIC_FALLBACK !== "true") {
      return r2;
    }
    logEvent(env, "warn", "r2_static_fallback", {
      artifact_path: artifactPath,
      r2_code: r2.code,
    });
    return readAsset(env, artifactPath, storageTier);
  }

  // R2-preferred dual artifacts (coverage/subnets): serve the fresh published R2
  // copy so per-publish fields (native_snapshot_captured_at, coverage counts)
  // are current, falling back to the committed baseline when R2 is cold. They
  // stay dual so the changelog/ci-verify still read the committed copy.
  if (isR2PreferredDualArtifactPath(artifactPath)) {
    const r2Preferred = await readR2(env, artifactPath, storageTier);
    if (r2Preferred.ok) {
      return r2Preferred;
    }
    const assetFallback = await readAsset(env, artifactPath, storageTier);
    if (assetFallback.ok) {
      return assetFallback;
    }
    return r2Preferred.status !== 404 ? r2Preferred : assetFallback;
  }

  const asset = await readAsset(env, artifactPath, storageTier);
  if (asset.ok) {
    return asset;
  }

  const r2 = await readR2(env, artifactPath, storageTier);
  if (r2.ok) {
    return r2;
  }

  return asset.status !== 404 ? asset : r2;
}

export async function readAsset(
  env: Env,
  artifactPath: string,
  storageTier: string,
): Promise<StorageReadResult> {
  if (!env.ASSETS?.fetch) {
    return {
      ok: false,
      status: 404,
      code: "asset_binding_missing",
      message: "No ASSETS binding is configured.",
    };
  }

  const response = await env.ASSETS.fetch(
    new Request(`https://assets.local${artifactPath}`),
  );
  if (!response.ok) {
    await response.body?.cancel?.();
    return {
      ok: false,
      status: response.status,
      code: "artifact_not_found",
      message: `Artifact not found in static assets: ${artifactPath}`,
    };
  }

  return {
    ok: true,
    data: await response.json(),
    source: "static-assets",
    storage_tier: storageTier,
  };
}

export async function readR2(
  env: Env,
  artifactPath: string,
  storageTier: string,
): Promise<StorageReadResult> {
  const result = await readR2Object(env, artifactPath, storageTier);
  if (!result.ok) {
    return result;
  }
  return {
    ok: true,
    data: await result.object.json(),
    source: "r2",
    storage_tier: storageTier,
    resolution: result.resolution,
  };
}

// Same R2 fetch as readR2 (key resolution, timeout guard, not-found handling),
// but returns the raw R2Object instead of parsing it as JSON -- for binary
// artifacts (the og-image.png card, see src/og-image.ts) that readR2's
// .json() would throw on. readR2 above is implemented in terms of this.
export async function readR2Object(
  env: Env,
  artifactPath: string,
  storageTier: string,
): Promise<R2ObjectReadResult> {
  if (!env.METAGRAPH_ARCHIVE?.get) {
    return {
      ok: false,
      status: 404,
      code: "r2_binding_missing",
      message: "No R2 archive binding is configured.",
    };
  }

  const { key, resolution } = await resolveArtifactKey(artifactPath, env);
  let object;
  try {
    object = await withTimeout(
      env.METAGRAPH_ARCHIVE.get(key),
      r2TimeoutMs(env),
    );
  } catch {
    logEvent(env, "warn", "r2_read_timeout", {
      key,
      storage_tier: storageTier,
    });
    return {
      ok: false,
      status: 504,
      code: "r2_timeout",
      message: `R2 read timed out: ${key}`,
    };
  }
  if (!object) {
    // #8276 follow-up: #8278 stopped the pointer WRITER from naming a prefix
    // nothing writes, but a bad pointer already in KV keeps 404ing every
    // artifact until the next publish rewrites it -- and a publish is ~50
    // minutes that can itself fail. A pointer prefix that holds no objects
    // takes the whole R2-backed API down at once (/api/v1/subnets, /coverage,
    // every per-subnet artifact), so recover on read instead of waiting:
    // retry once at the literal latest/ tree, which r2-upload populates for
    // every artifact on every run.
    //
    // Deliberately narrow: only when the pointer sent us somewhere OTHER than
    // latest/ (so the normal path costs nothing), and it warns rather than
    // healing silently -- a permanent fallback means the pointer is still
    // wrong and should be fixed, not tolerated.
    const fallbackKey = `latest/${artifactPath.replace(/^\/metagraph\//, "")}`;
    if (fallbackKey !== key) {
      let fallbackObject;
      try {
        fallbackObject = await withTimeout(
          env.METAGRAPH_ARCHIVE.get(fallbackKey),
          r2TimeoutMs(env),
        );
      } catch {
        fallbackObject = null;
      }
      if (fallbackObject) {
        logEvent(env, "warn", "r2_pointer_prefix_miss", {
          key,
          fallback_key: fallbackKey,
          storage_tier: storageTier,
          // #8287: the strategy that MISSED, so triage knows whether the run
          // manifest or the pointer prefix sent the read somewhere empty.
          attempted_resolution: resolution,
        });
        return {
          ok: true,
          object: fallbackObject,
          source: "r2",
          storage_tier: storageTier,
          resolution: "fallback",
        };
      }
    }
    return {
      ok: false,
      status: 404,
      code: "artifact_not_found",
      message: `Artifact not found in R2: ${key}`,
    };
  }

  return {
    ok: true,
    object,
    source: "r2",
    storage_tier: storageTier,
    resolution,
  };
}

// Artifacts that read through the literal "latest/" prefix instead of the
// versioned run-prefix the KV pointer names. Every OTHER artifact resolves
// through that run-prefix pointer deliberately (see kv-publish-pointer.ts's
// own comment: pointing latest_prefix at the immutable run prefix, not the
// mutable literal "latest/" prefix, avoids ever serving a mix of stale +
// fresh artifacts from a partially-uploaded publish). That atomicity
// guarantee only matters for artifacts a publish is expected to refresh
// WHOLESALE every run; it actively hurts two different classes of artifact
// that don't fit that shape, both fixed here (#6508, #6509):
//
//   - health/history/{date}.json: a write-once key per date, never
//     overwritten by a later publish. The run-prefix tree only ever
//     contains THAT run's single date, so every prior date became
//     unreachable the moment a new run's publish flipped the pointer, even
//     though the write side faithfully writes one dated snapshot every day.
//   - schemas/{surface_id}.json and fixtures/{surface_id}.json: mutable,
//     but populated by a BEST-EFFORT per-item live capture (a third-party
//     host being briefly unreachable skips writing that one item for this
//     run, without failing the whole publish). The run-prefix tree only
//     ever contains what THIS run's capture actually produced, so a single
//     transient per-item failure makes that item vanish from the current
//     run-prefix entirely -- even though a perfectly good prior capture is
//     still sitting untouched under the literal "latest/" key.
//
// r2-upload.ts already uploads every artifact to BOTH keys
// (METAGRAPH_R2_UPLOAD_HISTORY=1 in production); the literal "latest/"
// prefix is only ever updated on a SUCCESSFUL capture for these artifacts
// (never deleted on failure), so reading it directly is strictly safer than
// the run-prefix for this shape -- confirmed live for both classes: 30/30
// recent health/history dates and a known schemas/{surface_id}.json (whose
// pointer-resolved path 404'd) were both readable at their literal
// "latest/" key.
const STABLE_LATEST_ARTIFACT_PATTERNS = [
  /^\/metagraph\/health\/history\/\d{4}-\d{2}-\d{2}\.json$/,
  /^\/metagraph\/schemas\/(?!index\.json$)[A-Za-z0-9._:-]+\.json$/,
  // Excludes _capture-report.json (a whole-run summary, not a per-item
  // capture) -- the surface_id charset (see get_api_schema's own validation
  // in src/mcp-server.ts) includes "_", so this needs the same explicit
  // exclusion as schemas/index.json above, not just relying on the charset.
  /^\/metagraph\/fixtures\/(?!_capture-report\.json$)[A-Za-z0-9._:-]+\.json$/,
];

/**
 * Resolve an artifact's R2 key AND report which strategy produced it (#8287).
 *
 * `latestR2Key` below is the key-only wrapper every existing caller uses; this
 * exists so `readR2Object` can surface the strategy without every call site
 * having to care. Stable-latest artifacts report `prefix`: they bypass the
 * pointer by design, so "manifest vs prefix" is not a health signal for them.
 */
export async function resolveArtifactKey(
  artifactPath: string,
  env: Env,
): Promise<{ key: string; resolution: ArtifactResolution }> {
  const relativePath = artifactPath.replace(/^\/metagraph\//, "");
  if (
    STABLE_LATEST_ARTIFACT_PATTERNS.some((pattern) =>
      pattern.test(artifactPath),
    )
  ) {
    return { key: `latest/${relativePath}`, resolution: "prefix" };
  }
  const pointer = await latestPointer(env);
  // #8277: prefer the run's immutable manifest. It maps this artifact path to a
  // content-addressed by-hash key, so the pointer flip is the single atomic
  // switch between runs and an in-flight publish overwriting the mutable
  // latest/ tree can never be observed mid-way. Best-effort: an older pointer
  // without the key, an unreadable manifest, or a path the manifest doesn't
  // name all fall through to the prefix resolution below unchanged.
  if (pointer?.full_manifest_run_key && env.METAGRAPH_ARCHIVE) {
    const index = await runManifestIndex(env, pointer.full_manifest_run_key);
    const key = index?.get(artifactPath);
    if (key) return { key, resolution: "manifest" };
  }
  const prefix =
    pointer?.latest_prefix || env.METAGRAPH_R2_LATEST_PREFIX || "latest/";
  return { key: `${prefix}${relativePath}`, resolution: "prefix" };
}

export async function latestR2Key(
  artifactPath: string,
  env: Env,
): Promise<string> {
  return (await resolveArtifactKey(artifactPath, env)).key;
}

// In-isolate memo for the publish pointer (#367). Cloudflare reuses Worker
// isolates across requests, so a short TTL collapses the per-request KV read on
// the hot path — latestPointer feeds every origin-miss R2 read + /health. The
// pointer changes at most a few times a day (event-driven publish, ADR 0007), so
// a 60s TTL is bounded staleness: a flipped pointer propagates within the window,
// and the immutable run-prefix means the previous prefix's objects stay valid in
// the meantime, so a request served from a just-stale pointer never 404s. Keyed
// on the env object so tests (and any multi-binding caller) never cross-read.
const POINTER_MEMO_TTL_MS = 60_000;
let pointerMemo: {
  env: Env | null;
  value: LatestPointer | null;
  expiresAt: number;
} = { env: null, value: null, expiresAt: 0 };

export async function latestPointer(env: Env): Promise<LatestPointer | null> {
  if (!env.METAGRAPH_CONTROL?.get) {
    return null;
  }
  const now = Date.now();
  if (pointerMemo.env === env && now < pointerMemo.expiresAt) {
    return pointerMemo.value;
  }
  try {
    const value = await env.METAGRAPH_CONTROL.get<LatestPointer>(
      METAGRAPH_LATEST_KEY,
      { type: "json" },
    );
    pointerMemo = { env, value, expiresAt: now + POINTER_MEMO_TTL_MS };
    return value;
  } catch {
    return null;
  }
}

// Read a live health snapshot written by the cron prober (KV health:* keys).
// Returns null when KV is unbound or the key is cold so callers fall back to the
// static artifact.
export async function readHealthKv(env: Env, key: string): Promise<unknown> {
  if (!env.METAGRAPH_CONTROL?.get) {
    return null;
  }
  try {
    return await env.METAGRAPH_CONTROL.get(key, { type: "json" });
  } catch {
    return null;
  }
}
