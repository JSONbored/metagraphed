import { generatedArtifactDb } from "./generated-artifact-db.ts";

/** Keep the proxy's existing upstream/failure fixtures behind the D1 boundary. */
export function iconCacheDb(value: unknown) {
  const store = value as
    | {
        get(key: string): Promise<{
          body?: unknown;
          httpMetadata?: unknown;
          customMetadata?: unknown;
        } | null>;
        put(key: string, body: Uint8Array, metadata: unknown): Promise<unknown>;
      }
    | undefined;
  if (!store) return undefined;
  return generatedArtifactDb({
    async get(key: string) {
      const cached = await store.get(key);
      if (!cached) return null;
      const body =
        cached.body instanceof ArrayBuffer || cached.body instanceof Uint8Array
          ? Buffer.from(cached.body as ArrayBuffer)
          : Buffer.alloc(0);
      return {
        json: async () => ({
          data: body.toString("base64"),
          httpMetadata: cached.httpMetadata,
          customMetadata: cached.customMetadata,
        }),
      };
    },
    async put(key: string, payload: string) {
      const { data, ...metadata } = JSON.parse(payload);
      return store.put(
        key,
        new Uint8Array(Buffer.from(data, "base64")),
        metadata,
      );
    },
  });
}
