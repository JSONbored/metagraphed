import { createHash } from "node:crypto";

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
  if (stream !== null)
    put("metagraph/projections/chain-ownership.json", {
      schema_version: 1,
      rows: stream,
    });
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
    R2_SQL_TOKEN: "legacy-must-not-be-used",
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
