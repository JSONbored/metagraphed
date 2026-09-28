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

const R2_API_BASE_URL_DEFAULT = "https://api.cloudflare.com/client/v4";

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
      "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required for Cloudflare storage access.",
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

/** Read a small cron snapshot from D1; optional enrichment retains its seed
 * when credentials, the store, or valid object data are unavailable. */
export async function readGeneratedStoreJson(
  key: string,
  timeoutMs = 30_000,
): Promise<Record<string, unknown> | null> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) return null;
  try {
    const { readFile } = await import("node:fs/promises");
    const { stripJsonComments } = await import("./lib.ts");
    const { d1AdminBatch } = await import("./lib/d1-admin.ts");
    const config = JSON.parse(
      stripJsonComments(
        await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
      ),
    ) as { d1_databases: { binding: string; database_id: string }[] };
    const databaseId =
      process.env.CLOUDFLARE_D1_DATABASE_ID ??
      config.d1_databases.find((row) => row.binding === "D1_STATE")
        ?.database_id;
    if (!databaseId) return null;
    const result = await d1AdminBatch(
      [
        {
          sql: "SELECT payload FROM generated_artifacts WHERE key=?",
          params: [key],
        },
      ],
      { accountId, apiToken, databaseId },
      (url, init) =>
        fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
    );
    const payload = result[0]?.results[0]?.payload;
    const doc: unknown =
      typeof payload === "string" ? JSON.parse(payload) : null;
    return doc && typeof doc === "object" && !Array.isArray(doc)
      ? (doc as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
