import { generatedArtifactStore } from "./generated-artifact-store.ts";

export const MAX_ICON_BYTES = 256 * 1024;
interface IconMetadata {
  httpMetadata?: { contentType?: string; cacheControl?: string };
  customMetadata?: Record<string, string>;
}

/** Preserve image bytes and global negative-cache windows in the existing store. */
export function iconCacheStore(db?: Pick<D1Database, "prepare">) {
  const store = generatedArtifactStore(db);
  if (!store) return undefined;
  return {
    async get(key: string) {
      const value = (await store.get(key)) as
        (IconMetadata & { data?: unknown }) | null;
      if (
        typeof value?.data !== "string" ||
        value.data.length > Math.ceil(MAX_ICON_BYTES / 3) * 4
      )
        return null;
      const bytes = Uint8Array.from(atob(value.data), (c) => c.charCodeAt(0));
      if (bytes.byteLength > MAX_ICON_BYTES) return null;
      return {
        body: bytes.buffer,
        size: bytes.byteLength,
        httpMetadata: value.httpMetadata,
        customMetadata: value.customMetadata,
      };
    },
    async put(
      key: string,
      body: ArrayBuffer | Uint8Array,
      metadata: IconMetadata,
    ) {
      const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
      if (bytes.byteLength > MAX_ICON_BYTES)
        throw new Error("Icon cache entry exceeds its byte budget");
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 16_384)
        binary += String.fromCharCode(
          ...bytes.subarray(offset, offset + 16_384),
        );
      await store.put(key, JSON.stringify({ data: btoa(binary), ...metadata }));
    },
  };
}
