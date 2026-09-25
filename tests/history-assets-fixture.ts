import { createHash } from "node:crypto";
import { vi } from "vitest";
import type { HistoryAssetShard } from "../schemas-src/artifacts/history-assets.ts";

export const assetHash = (raw: Uint8Array | string) =>
  createHash("sha256").update(raw).digest("hex");
export const assetKey = (name: string) =>
  `metagraph/indexed-history/v1/mainnet/extrinsics/generations/${"a".repeat(64)}/feeds/v1/directory/${assetHash(name)}.json`;

export function historyAssetsFixture(
  inputs: { key: string; etag: string; chunks: Uint8Array[] }[],
) {
  const files = new Map<string, Uint8Array>();
  const shards: Record<string, HistoryAssetShard> = {};
  const store = (raw: Uint8Array) => {
    const sha256 = assetHash(raw);
    files.set(sha256, raw);
    return { sha256, bytes: raw.length };
  };
  for (const input of inputs) {
    const id = assetHash(input.key),
      prefix = id.slice(0, 2);
    const shard = (shards[prefix] ??= { version: 1, objects: {} });
    shard.objects[id] = {
      key: input.key,
      etag: input.etag,
      bytes: input.chunks.reduce((n, raw) => n + raw.length, 0),
      chunks: input.chunks.map(store),
    };
  }
  let override:
    | ((hash: string, raw: Uint8Array | undefined) => Response | undefined)
    | undefined;
  const fetch = vi.fn(async (request: Request) => {
    const match = /^\/([a-f0-9]{64})\.mgpack$/.exec(
      new URL(request.url).pathname,
    );
    if (!match) throw new Error("Unexpected asset path");
    const raw = files.get(match[1]);
    return (
      override?.(match[1], raw) ??
      (raw ? new Response(raw) : new Response(null, { status: 404 }))
    );
  });
  const env = { HISTORY_ASSETS: { fetch }, HISTORY_ASSET_RELEASE: "" };
  const publishRoot = (root: unknown) => {
    const ref = store(new TextEncoder().encode(JSON.stringify(root)));
    env.HISTORY_ASSET_RELEASE = `${ref.sha256}:${ref.bytes}`;
  };
  const root: {
    version: 1;
    partitionCount?: 16;
    shards: Record<string, { sha256: string; bytes: number }>;
  } = { version: 1, shards: {} };
  const publish = () => {
    root.shards = Object.fromEntries(
      Object.entries(shards).map(([prefix, shard]) => [
        prefix,
        store(new TextEncoder().encode(JSON.stringify(shard))),
      ]),
    );
    publishRoot(root);
  };
  publish();
  return {
    env,
    fetch,
    files,
    root,
    shards,
    publish,
    publishRoot,
    override(fn: typeof override) {
      override = fn;
    },
  };
}
