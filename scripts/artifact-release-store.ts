import {
  r2ObjectUrl,
  r2ApiBaseUrl,
  requireCloudflareCredentials,
} from "./r2-rest.ts";
import {
  assertReleaseOwner,
  jsonBytes,
  type ReleasePointer,
  type ReleaseStore,
} from "./artifact-release-commit.ts";

/** One budget includes source capture, object reconciliation and pointer commit. */
export class ReleaseBudget {
  requests = 0;
  bytes = 0;
  readonly deadline = Date.now() + 10 * 60_000;
  async request(url: string, init: RequestInit = {}): Promise<Response> {
    if (++this.requests > 64 || Date.now() >= this.deadline)
      throw new Error("Release request/time budget exhausted.");
    if (init.body instanceof Uint8Array) this.account(init.body.length);
    return fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(Math.min(15_000, this.deadline - Date.now())),
    });
  }
  account(size: number): void {
    this.bytes += size;
    if (this.bytes > 128 * 1024 * 1024)
      throw new Error("Release transfer budget exhausted.");
  }
  async read(response: Response, limit = 8 * 1024 * 1024): Promise<Buffer> {
    if (!response.body) throw new Error("Release response body missing.");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.length;
        this.account(item.value.length);
        if (size > limit || Date.now() >= this.deadline)
          throw new Error("Release response size/time limit exceeded.");
        chunks.push(item.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    }
    return Buffer.concat(chunks);
  }
}

export function createReleaseStore(
  write: boolean,
  budget = new ReleaseBudget(),
): ReleaseStore {
  if (write) assertReleaseOwner(process.env);
  const { accountId, apiToken } = requireCloudflareCredentials();
  const namespace = process.env.METAGRAPH_KV_NAMESPACE_ID;
  if (!namespace) throw new Error("METAGRAPH_KV_NAMESPACE_ID is required.");
  const headers = { authorization: `Bearer ${apiToken}` };
  const bucket = "metagraphed-artifacts";
  const pointerUrl = `${r2ApiBaseUrl()}/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces/${encodeURIComponent(namespace)}/values/metagraph%3Alatest`;
  return {
    async get(key) {
      const response = await budget.request(
        r2ObjectUrl(accountId, bucket, key),
        { headers },
      );
      if (response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`R2 read indeterminate (${response.status}): ${key}`);
      }
      return {
        bytes: await budget.read(response),
        contentType: response.headers.get("content-type") ?? "",
      };
    },
    async put(object) {
      if (!write) throw new Error("Read-only release store.");
      const response = await budget.request(
        r2ObjectUrl(accountId, bucket, object.key),
        {
          method: "PUT",
          headers: { ...headers, "content-type": object.contentType },
          body: Buffer.from(object.bytes),
        },
      );
      await response.body?.cancel();
      if (!response.ok)
        throw new Error(
          `R2 write acknowledgement failed (${response.status}): ${object.key}`,
        );
    },
    async getPointer() {
      const response = await budget.request(pointerUrl, { headers });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Pointer read indeterminate (${response.status}).`);
      }
      const pointer: unknown = JSON.parse(
        (await budget.read(response, 64 * 1024)).toString(),
      );
      if (!pointer || typeof pointer !== "object" || Array.isArray(pointer))
        throw new Error("Pointer is not an object.");
      return pointer as ReleasePointer;
    },
    async putPointer(pointer) {
      if (!write) throw new Error("Read-only release store.");
      const response = await budget.request(pointerUrl, {
        method: "PUT",
        headers: { ...headers, "content-type": "application/json" },
        body: jsonBytes(pointer),
      });
      const result = await budget.read(response, 64 * 1024);
      if (!response.ok || JSON.parse(result.toString()).success !== true)
        throw new Error("Pointer write acknowledgement uncertain.");
    },
  };
}
