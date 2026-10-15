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

// Match the write diagnostics' fixed-vocabulary convention. Never return raw
// provider text: SQL, bindings and credentials can be echoed inside an error.
const PROVIDER_MESSAGES = new Map([
  ["authentication error", "Authentication error"],
  ["unauthorized", "Unauthorized"],
  ["forbidden", "Forbidden"],
  ["access denied", "Access denied"],
  ["permission denied", "Permission denied"],
  ["invalid api token", "Invalid API token"],
  ["invalid access token", "Invalid access token"],
  ["token has expired", "Token has expired"],
  ["request is not authorized", "Request is not authorized"],
  ["exceeded maximum db size", "Exceeded maximum DB size"],
]);
const ERROR_BODY_MAX_BYTES = 16 * 1024;
type ProviderError = { code?: unknown; message?: unknown } | null | undefined;

async function readErrorBody(response: Response): Promise<{
  text?: string;
  state: "complete" | "empty" | "oversized" | "unreadable";
}> {
  if (!response.body) return { state: "empty" };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0,
      text = "";
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > ERROR_BODY_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { state: "oversized" };
      }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    if (bytes === 0) return { state: "empty" };
    return { state: "complete", text };
  } catch {
    await reader?.cancel().catch(() => undefined);
    return { state: "unreadable" };
  } finally {
    reader?.releaseLock();
  }
}

async function httpFailure(
  response: Response,
  statements: readonly D1AdminStatement[],
  credentials: D1AdminCredentials,
): Promise<Error> {
  const prefix = `D1 maintenance request failed with HTTP ${response.status}`;
  try {
    const fields: string[] = [];
    const privateValues = [
      credentials.apiToken,
      credentials.accountId,
      credentials.databaseId,
      ...statements.flatMap(({ sql, params = [] }) => [sql, ...params]),
    ];
    const echoesInput = (value: string) =>
      privateValues.some(
        (input) =>
          input.length > 0 &&
          input.length <= value.length &&
          value.toLowerCase().includes(input.toLowerCase()),
      );
    // Only a validated opaque Ray ID is retained, never response headers.
    const ray = response.headers.get("cf-ray");
    if (
      ray &&
      (ray.length === 16 || ray.length === 20) &&
      /^[a-fA-F0-9]{16}(?:-[A-Z]{3})?$/.test(ray) &&
      !echoesInput(ray)
    )
      fields.push(`request_id=${ray}`);
    const body = await readErrorBody(response);
    let state: string = body.state;
    if (body.state === "complete") {
      try {
        const payload = JSON.parse(body.text!) as { errors?: unknown } | null;
        const errors = payload?.errors;
        let first: ProviderError;
        if (Array.isArray(errors)) first = errors[0] as ProviderError;
        const code = first?.code;
        const message = first?.message;
        if (
          typeof code === "number" &&
          Number.isSafeInteger(code) &&
          code >= 0 &&
          code <= 2_147_483_647 &&
          !echoesInput(String(code))
        )
          fields.push(`provider_code=${code}`);
        if (typeof message === "string") {
          let known: string | undefined;
          if (message.length <= 512)
            known = PROVIDER_MESSAGES.get(
              message.trim().replace(/\s+/g, " ").toLowerCase(),
            );
          let safeMessage = "Provider message redacted";
          if (known && !echoesInput(known)) safeMessage = known;
          fields.push(`provider_message=${safeMessage}`);
        }
        if (first) state = "json";
        else state = "unrecognized";
      } catch {
        state = "malformed";
      }
    }
    fields.push(`error_body=${state}`);
    return new Error(`${prefix}; ${fields.join("; ")}`);
  } catch {
    // Best-effort diagnostics, including cancellation and lock cleanup, must
    // never replace the original HTTP classification with another exception.
    return new Error(`${prefix}; error_body=unavailable`);
  }
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
    throw await httpFailure(response, statements, credentials);
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
