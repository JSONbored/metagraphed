// Shared Cloudflare R2 REST access used by the publish scripts.
//
// Extracted so the uploader (scripts/r2-upload.ts) and the pointer readback
// gate (scripts/kv-publish-pointer.ts) build object URLs and read credentials
// exactly one way. A second, subtly different copy is how the 2026-07-26
// outage class starts: the uploader wrote one key shape while the pointer
// claimed another, and nothing compared them.
//
// Pure module — no top-level execution, so it is safe to import from any
// script (r2-upload.ts itself runs on import and cannot be imported).

export const R2_API_BASE_URL_DEFAULT = "https://api.cloudflare.com/client/v4";

/**
 * Test-only seam: lets tests point at a local mock HTTP server instead of the
 * real Cloudflare API. Never set in production.
 */
export function r2ApiBaseUrl(): string {
  return process.env.METAGRAPH_R2_API_BASE_URL || R2_API_BASE_URL_DEFAULT;
}

export function requireCloudflareCredentials(): {
  accountId: string;
  apiToken: string;
} {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new Error(
      "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required for R2 access.",
    );
  }
  return { accountId, apiToken };
}

/**
 * R2 keys are hierarchical ("latest/subnets.json", "by-hash/<sha256>"): encode
 * each path segment individually so the literal `/` separators survive while
 * any segment containing reserved characters is still safely escaped.
 */
export function encodeR2Key(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

export function r2ObjectUrl(
  accountId: string,
  bucketName: string,
  key: string,
): string {
  return `${r2ApiBaseUrl()}/accounts/${accountId}/r2/buckets/${bucketName}/objects/${encodeR2Key(key)}`;
}

/**
 * Does this exact key exist in the bucket? A HEAD, so no body is transferred.
 *
 * Distinguishes "definitely absent" (a clean 404) from "could not tell" (any
 * network/timeout/non-404 failure) rather than collapsing both to false: the
 * readback gate must not fail a publish because R2 was briefly unreachable,
 * and must not pass one because it never got an answer.
 */
export async function r2ObjectExists(
  accountId: string,
  bucketName: string,
  key: string,
  apiToken: string,
  timeoutMs = 15_000,
): Promise<{ exists: boolean; determinate: boolean; status?: number }> {
  try {
    const res = await fetch(r2ObjectUrl(accountId, bucketName, key), {
      method: "HEAD",
      headers: { Authorization: `Bearer ${apiToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return { exists: true, determinate: true, status: res.status };
    if (res.status === 404) {
      return { exists: false, determinate: true, status: 404 };
    }
    return { exists: false, determinate: false, status: res.status };
  } catch {
    return { exists: false, determinate: false };
  }
}

/**
 * Read one Worker-cron-written `generated/*` store object as JSON (#9096).
 *
 * The Worker crons that replaced this repo's machine-data bot-PR lanes write
 * their output to keys under `generated/`, outside the publish pipeline's
 * `latest/` / `runs/` / `by-hash/` trees. Node-side readers (the artifact
 * build, the registry validators) reach them through Cloudflare's R2 REST API
 * with the same credential pair the publish scripts already use. One shared
 * implementation so every store reader agrees on the bucket, the URL shape,
 * and — critically — the failure posture.
 *
 * Returns null whenever the store cannot be read AS FRESH TRUTH: credentials
 * absent (local dev, and the Validate CI lane, which is what keeps
 * tests/artifacts-build-determinism.test.ts network-free), a fetch failure, or
 * a body that is not a JSON object. Null means the caller falls back to its
 * committed seed, never a hard error — the same tolerant posture every
 * optional registry enrichment here follows.
 */
export async function readGeneratedStoreJson(
  key: string,
  timeoutMs = 30_000,
): Promise<Record<string, unknown> | null> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    return null;
  }
  try {
    const { readFile } = await import("node:fs/promises");
    let bucketName = "metagraphed-artifacts";
    try {
      const manifest = JSON.parse(
        await readFile(
          new URL("../public/metagraph/r2-manifest.json", import.meta.url),
          "utf8",
        ),
      ) as { bucket_name?: unknown };
      if (typeof manifest.bucket_name === "string" && manifest.bucket_name) {
        bucketName = manifest.bucket_name;
      }
    } catch {
      // No committed manifest (a fresh checkout of a sparse tree): the default
      // bucket name is the same one the manifest carries in practice.
    }
    const response = await fetch(r2ObjectUrl(accountId, bucketName, key), {
      headers: { authorization: `Bearer ${apiToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return null;
    }
    const doc = (await response.json()) as unknown;
    return doc && typeof doc === "object" && !Array.isArray(doc)
      ? (doc as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
