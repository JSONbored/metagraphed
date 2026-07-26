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
