// Storage + IO layer for the API Worker — artifact reads (R2 + static-asset
// tiers with fallback), the latest-pointer / health-KV reads, request logging,
// and the timeout guards that bound R2/D1 access. Extracted from workers/api.mjs
// (issue #510, de-monolith) as a leaf module: it imports only the artifact-tier
// contract and a config key, and calls nothing back into api.mjs, so handlers
// and the response builders can share it without an import cycle.
import {
  artifactStorageTierForPath,
  ARTIFACT_STORAGE_TIERS,
  isR2PreferredDualArtifactPath,
} from "../src/artifact-storage.mjs";
import { METAGRAPH_LATEST_KEY } from "./config.mjs";

const DEFAULT_R2_TIMEOUT_MS = 5000;
const DEFAULT_D1_TIMEOUT_MS = 5000;

// Structured request logging on non-happy paths (R2 timeout, static fallback) so
// it does not spam logs. Disabled with METAGRAPH_DISABLE_REQUEST_LOGS=true.
export function logEvent(env, level, event, fields = {}) {
  if (env.METAGRAPH_DISABLE_REQUEST_LOGS === "true") {
    return;
  }
  try {
    console.log(JSON.stringify({ level, event, ...fields }));
  } catch {
    // Never let logging break a request.
  }
}

export function r2TimeoutMs(env) {
  const raw = Number(env.METAGRAPH_R2_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_R2_TIMEOUT_MS;
}

// Health-analytics D1 reads (trends/percentiles/incidents/uptime) can scan large
// time-series. Bound them so a slow/degraded query degrades to the route's normal
// empty-result path instead of holding the isolate until the CPU limit kills it.
// Tunable via METAGRAPH_D1_TIMEOUT_MS.
export function d1TimeoutMs(env) {
  const raw = Number(env.METAGRAPH_D1_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_D1_TIMEOUT_MS;
}

// R2's get() takes no AbortSignal, so bound it with a race: a slow/degraded
// bucket yields a controlled 504 (and static fallback where allowed) instead of
// hanging the request until the platform wall-clock limit.
export async function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function readArtifact(env, artifactPath) {
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

export async function readAsset(env, artifactPath, storageTier) {
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

export async function readR2(env, artifactPath, storageTier) {
  if (!env.METAGRAPH_ARCHIVE?.get) {
    return {
      ok: false,
      status: 404,
      code: "r2_binding_missing",
      message: "No R2 archive binding is configured.",
    };
  }

  const key = await latestR2Key(artifactPath, env);
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
    return {
      ok: false,
      status: 404,
      code: "artifact_not_found",
      message: `Artifact not found in R2: ${key}`,
    };
  }

  return {
    ok: true,
    data: await object.json(),
    source: "r2",
    storage_tier: storageTier,
  };
}

export async function latestR2Key(artifactPath, env) {
  const pointer = await latestPointer(env);
  const prefix =
    pointer?.latest_prefix || env.METAGRAPH_R2_LATEST_PREFIX || "latest/";
  return `${prefix}${artifactPath.replace(/^\/metagraph\//, "")}`;
}

export async function latestPointer(env) {
  if (!env.METAGRAPH_CONTROL?.get) {
    return null;
  }

  try {
    return await env.METAGRAPH_CONTROL.get(METAGRAPH_LATEST_KEY, {
      type: "json",
    });
  } catch {
    return null;
  }
}

// Read a live health snapshot written by the cron prober (KV health:* keys).
// Returns null when KV is unbound or the key is cold so callers fall back to the
// static artifact.
export async function readHealthKv(env, key) {
  if (!env.METAGRAPH_CONTROL?.get) {
    return null;
  }
  try {
    return await env.METAGRAPH_CONTROL.get(key, { type: "json" });
  } catch {
    return null;
  }
}
