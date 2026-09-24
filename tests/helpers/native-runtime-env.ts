import {
  decodeWatermarkKey,
  resetDecodeWatermarkCache,
} from "../../src/decode-watermark.ts";

/** Immutable transport fixture: exercise the real summary and generation readers. */
export function nativeRuntimeEnv(
  transitions: Record<string, unknown>[],
  latest = transitions.at(-1),
) {
  resetDecodeWatermarkCache();
  const keys: string[] = [];
  const objects = new Map<string, Uint8Array>();
  const generation = "a".repeat(64),
    network = "mainnet",
    table = "blocks";
  const root = `metagraph/indexed-history/v1/mainnet/blocks/generations/${generation}`;
  const firstBlock = Number(transitions[0]?.block_number ?? 0);
  const lastBlock = Number(latest?.block_number ?? firstBlock);
  const rows = lastBlock - firstBlock + 1;
  const put = (key: string, value: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    objects.set(key, bytes);
    return { key, etag: "fixture", bytes: bytes.length };
  };
  const manifest = put(`${root}/block-manifest.json`, {
    version: 1,
    generation,
    network,
    table,
    state: "complete",
    sourceSnapshot: "1",
    rows,
    files: [
      { key: `${root}/files/00000.json`, etag: "fixture", bytes: 100, rows },
    ],
    blockIndex: {
      key: `${root}/blocks/index.json`,
      etag: "fixture",
      bytes: 100,
    },
  });
  put(`${root}/runtime.json`, {
    version: 1,
    generation,
    network,
    table,
    sourceSnapshot: "1",
    rows,
    versionedRows: rows,
    transitions,
    latest: latest
      ? { spec_version: latest.spec_version, block_number: latest.block_number }
      : null,
  });
  put("metagraph/indexed-history/v1/mainnet/blocks/current.json", {
    version: 2,
    network,
    table,
    segments: [
      {
        generation,
        network,
        table,
        firstBlock,
        lastBlock,
        blockManifest: manifest,
      },
    ],
  });
  put(decodeWatermarkKey(), {
    decoded_through: lastBlock,
    per_table: { blocks: lastBlock },
  });
  return {
    keys,
    env: {
      NATIVE_PROJECTIONS: "enabled",
      NATIVE_HISTORY_FIXTURE: "legacy-must-not-be-used",
      METAGRAPH_ARCHIVE: {
        async get(
          key: string,
          options?: { range?: { offset: number; length: number } },
        ) {
          keys.push(key);
          const bytes = objects.get(key);
          if (!bytes) return null;
          const range = options?.range,
            body = range
              ? bytes.slice(range.offset, range.offset + range.length)
              : bytes;
          return {
            etag: "fixture",
            size: bytes.length,
            range,
            body: new Blob([body]).stream(),
            text: async () => new TextDecoder().decode(bytes),
            json: async () => JSON.parse(new TextDecoder().decode(bytes)),
          };
        },
      },
    } as unknown as Env,
  };
}
