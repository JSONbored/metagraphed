import assert from "node:assert/strict";
import { historyAssetsFixture } from "./history-assets-fixture.ts";

/** Relocate only the small immutable objects exercised by a native fixture. */
export async function nativeHistoryAssetsFixture(
  bucket: Pick<R2Bucket, "get">,
  keys: Iterable<string>,
) {
  const objects = [];
  for (const key of new Set(keys)) {
    const object = await bucket.get(key);
    assert.ok(object && object.size <= 8 * 1024 * 1024);
    const raw = new Uint8Array(await object.arrayBuffer());
    const chunks = [];
    for (let offset = 0; offset < raw.length; offset += 128 * 1024)
      chunks.push(raw.slice(offset, offset + 128 * 1024));
    objects.push({ key, etag: object.etag, chunks });
  }
  const fixture = historyAssetsFixture(objects);
  return {
    NATIVE_HISTORY_ASSETS: fixture.env.HISTORY_ASSETS,
    NATIVE_HISTORY_ASSET_RELEASE: fixture.env.HISTORY_ASSET_RELEASE,
  };
}
