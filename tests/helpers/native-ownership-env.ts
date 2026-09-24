import { createHash } from "node:crypto";
import { NATIVE_PROJECTION_FILES } from "../../src/native-projection-store.ts";

/** Native ownership projection plus a complete immutable observation archive. */
export function nativeOwnershipEnv(
  stream: Record<string, unknown>[] | null = [],
  observations: Record<string, unknown>[] | null = [],
) {
  const table = "subnet_ownership_history";
  const source = {
    sequence: 1,
    snapshot: "1",
    sources: [
      {
        bucket: "fixture",
        bytes: 1,
        etag: "source",
        key: "ownership.parquet",
        network: "mainnet",
        rows: observations?.length ?? 0,
        table,
      },
    ],
    tableUuid: "ownership-fixture",
  };
  const generation = createHash("sha256")
    .update(JSON.stringify(source))
    .digest("hex");
  const root = `metagraph/state-archive/v1/${table}`;
  const rows = (observations ?? []).map((row, id) => ({
    id,
    netuid: null,
    owner_hotkey: null,
    owner_coldkey: null,
    captured_at: null,
    ...row,
  }));
  const objects = new Map<
    string,
    { raw: string; etag: string; size: number }
  >();
  const put = (key: string, value: unknown) => {
    const raw = JSON.stringify(value),
      etag = createHash("md5").update(raw).digest("hex"),
      size = Buffer.byteLength(raw);
    objects.set(key, { raw, etag, size });
    return { key, etag, bytes: size };
  };
  const generatedAt = Date.now();
  const nativeRoot = `metagraph/native-projections/v1/mainnet/${generation}/`;
  const artifacts = NATIVE_PROJECTION_FILES.map((file) => {
    const object = put(nativeRoot + file, {
      schema_version: 1,
      generated_at: new Date(generatedAt).toISOString(),
      rows: file === "chain-ownership.json" ? stream : [],
    });
    return {
      artifactKey: `metagraph/projections/${file}`,
      rowCount: file === "chain-ownership.json" ? (stream?.length ?? 0) : 0,
      object,
    };
  });
  put("metagraph/native-projections/v1/mainnet/current.json", {
    version: 1,
    state: "complete",
    network: "mainnet",
    generatedAt,
    readerCommit: "a".repeat(40),
    generation,
    artifacts,
    sources: ["blocks", "extrinsics", "account_events", "chain_events"].map(
      (table) => ({
        version: 1,
        network: "mainnet",
        table,
        table_uuid: table,
        snapshot: "1",
        sequence: 1,
        coverage: null,
        cutoff: generatedAt - 90 * 86400000,
      }),
    ),
  });
  if (stream === null) objects.delete(nativeRoot + "chain-ownership.json");
  if (observations !== null) {
    const object = put(`${root}/${generation}/rows.json`, {
      version: 1,
      table,
      generation,
      rows,
    });
    const manifest = {
      version: 1,
      table,
      generation,
      rowCount: rows.length,
      source,
      object,
    };
    put(`${root}/current.json`, manifest);
    put(`${root}/${generation}/manifest.json`, manifest);
  }
  const keys: string[] = [];
  const env = {
    NATIVE_PROJECTIONS: "enabled",
    NATIVE_HISTORY_FIXTURE: "legacy-must-not-be-used",
    METAGRAPH_ARCHIVE: {
      async get(key: string) {
        keys.push(key);
        const object = objects.get(key);
        return object
          ? { ...object, json: async () => JSON.parse(object.raw) }
          : null;
      },
    },
  };
  return { env, keys, objects };
}
