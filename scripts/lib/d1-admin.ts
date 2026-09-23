// Credentialed maintenance only: fixed Cloudflare origin, bounded responses,
// no Worker route and no automatic retry of an ambiguous write.
export interface D1AdminStatement {
  sql: string;
  params?: string[];
}
export interface D1AdminResult {
  results: Record<string, unknown>[];
  meta?: { changes?: number };
}
export interface D1AdminCredentials {
  accountId: string;
  databaseId: string;
  apiToken: string;
}
export function d1AdminCredentials(
  env: Record<string, string | undefined> = process.env,
): D1AdminCredentials {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const databaseId = env.CLOUDFLARE_D1_DATABASE_ID ?? "";
  const apiToken = env.CLOUDFLARE_API_TOKEN ?? "";
  if (
    !/^[a-f0-9]{32}$/i.test(accountId) ||
    !/^[a-f0-9-]{36}$/i.test(databaseId) ||
    !apiToken
  )
    throw new Error(
      "CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID and CLOUDFLARE_API_TOKEN are required for D1 maintenance",
    );
  return { accountId, databaseId, apiToken };
}
export async function d1AdminBatch(
  statements: readonly D1AdminStatement[],
  credentials = d1AdminCredentials(),
  transport: typeof fetch = fetch,
): Promise<D1AdminResult[]> {
  if (!statements.length || statements.length > 100)
    throw new Error("D1 maintenance batch must contain 1 to 100 statements");
  let response: Response;
  try {
    response = await transport(
      `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/d1/database/${credentials.databaseId}/query`,
      {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${credentials.apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ batch: statements }),
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch {
    throw new Error(
      "D1 maintenance request failed; verify state before retrying a write",
    );
  }
  if (!response.ok || !response.body)
    throw new Error(
      `D1 maintenance request failed with HTTP ${response.status}`,
    );
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let bytes = 0,
    text = "";
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 4 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("D1 maintenance response exceeds 4 MiB");
      }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  let payload: {
    success?: boolean;
    result?: (D1AdminResult & { success?: boolean })[];
  };
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("D1 maintenance response is not valid JSON");
  }
  if (
    !payload.success ||
    !Array.isArray(payload.result) ||
    payload.result.length !== statements.length ||
    payload.result.some(
      (result) => !result.success || !Array.isArray(result.results),
    )
  )
    throw new Error(
      "D1 maintenance batch failed or returned an invalid result",
    );
  return payload.result;
}
