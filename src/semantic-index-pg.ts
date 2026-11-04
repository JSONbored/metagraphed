import { randomUUID } from "node:crypto";
import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type { PgTransaction } from "./pg-pool.ts";
import type { SemanticIndex } from "./semantic-index.ts";
import { SemanticIndexMetadataSchema } from "../schemas-src/semantic-index-metadata.ts";

export interface SemanticIndexOptions {
  name: string;
  model: string;
  dimensions: number;
  maxVectors: number;
}
interface IndexRow {
  model: string;
  dimensions: number;
  max_vectors: number;
  vector_count: number;
}
interface MatchRow {
  id: string;
  score: number;
  metadata: string;
  embedding: number[];
}
const encoder = new TextEncoder();
function text(value: string, max: number, label: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\0") ||
    encoder.encode(value).length > max
  )
    throw new TypeError(`Invalid semantic index ${label}`);
  return value;
}
function vector(
  value: number[] | Float32Array | Float64Array,
  dimensions: number,
): number[] {
  if (
    (!Array.isArray(value) &&
      !(value instanceof Float32Array) &&
      !(value instanceof Float64Array)) ||
    value.length !== dimensions
  )
    throw new TypeError("Semantic vector dimensions differ from the index");
  return Array.from(value, (item) => {
    if (
      typeof item !== "number" ||
      !Number.isFinite(item) ||
      !Number.isFinite(Math.fround(item))
    )
      throw new TypeError("Semantic vectors require finite float32 values");
    return Math.fround(item);
  });
}
function typeFilter(
  filter: VectorizeVectorMetadataFilter | undefined,
): string[] | null {
  if (filter === undefined || Object.keys(filter).length === 0) return null;
  if (Object.keys(filter).length !== 1 || !Object.hasOwn(filter, "type"))
    throw new TypeError("Native semantic filters support the type field only");
  const value = filter.type;
  if (typeof value === "string") return [text(value, 256, "filter")];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (
      Object.keys(value).length === 1 &&
      "$eq" in value &&
      typeof value.$eq === "string"
    )
      return [text(value.$eq, 256, "filter")];
    if (
      Object.keys(value).length === 1 &&
      "$in" in value &&
      Array.isArray(value.$in) &&
      value.$in.length <= 100 &&
      value.$in.every((item) => typeof item === "string")
    )
      return value.$in.map((item) => text(item as string, 256, "filter"));
  }
  throw new TypeError(
    "Native semantic filters require type equality or an allow-list",
  );
}

/** A bounded exact index for registry vectors, owned by the application's pool.
 * Float32 storage matches the embedding index representation; no model calls,
 * service registration, extensions or pool lifecycle are hidden here. */
export async function createPgSemanticIndex(
  runtime: Pick<PgStoreRuntime, "transaction">,
  options: SemanticIndexOptions,
): Promise<SemanticIndex> {
  const name = text(options.name, 128, "name");
  const model = text(options.model, 256, "model");
  if (
    !Number.isSafeInteger(options.dimensions) ||
    options.dimensions < 1 ||
    options.dimensions > 4096 ||
    !Number.isSafeInteger(options.maxVectors) ||
    options.maxVectors < 1 ||
    options.maxVectors > 10000
  )
    throw new RangeError("Invalid semantic index dimensions or capacity");
  const matches = (row: IndexRow | null) =>
    row &&
    row.model === model &&
    row.dimensions === options.dimensions &&
    row.max_vectors === options.maxVectors;
  const checkReady = async (tx: PgTransaction) => {
    const ready = await tx.first<{ ready: boolean }>(
      "SELECT count(*)=2 AND bool_and(tgenabled IN ('O','A')) AS ready FROM pg_trigger WHERE tgrelid=to_regclass('search.vectors') AND NOT tgisinternal AND tgname IN ('vector_dimensions','vector_capacity')",
    );
    if (!ready?.ready)
      throw new Error("Native semantic schema is not activated");
  };
  await runtime.transaction(async (tx) => {
    await checkReady(tx);
    await tx.run(
      "INSERT INTO search.indexes(name,model,dimensions,max_vectors) VALUES (?,?,?,?) ON CONFLICT(name) DO NOTHING",
      [name, model, options.dimensions, options.maxVectors],
    );
    const row = await tx.first<IndexRow>(
      "SELECT * FROM search.indexes WHERE name=? FOR UPDATE",
      [name],
    );
    if (!matches(row)) throw new Error("Semantic index configuration differs");
    const count = await tx.first<{ count: number }>(
      "SELECT count(*)::integer AS count FROM search.vectors WHERE index_name=?",
      [name],
    );
    if (count!.count !== row!.vector_count)
      throw new Error("Semantic index capacity census differs");
  });
  const use = <T>(write: boolean, run: (tx: PgTransaction) => Promise<T>) =>
    runtime.transaction(async (tx) => {
      await checkReady(tx);
      const row = await tx.first<IndexRow>(
        `SELECT * FROM search.indexes WHERE name=? FOR ${write ? "UPDATE" : "SHARE"}`,
        [name],
      );
      if (!matches(row))
        throw new Error("Semantic index configuration differs");
      return run(tx);
    });
  return {
    async upsert(input) {
      if (!Array.isArray(input) || input.length < 1 || input.length > 100)
        throw new RangeError("Semantic upserts require 1 to 100 vectors");
      const rows = input.map((entry) => {
        const id = text(entry.id, 64, "vector id");
        if (entry.namespace)
          throw new TypeError(
            "Native semantic namespaces use separate index names",
          );
        const values = vector(entry.values, options.dimensions);
        const metadata = entry.metadata ?? {};
        if (typeof metadata !== "object" || Array.isArray(metadata))
          throw new TypeError("Semantic metadata must be an object");
        const json = JSON.stringify(metadata);
        if (typeof json !== "string" || !json.startsWith("{"))
          throw new TypeError("Semantic metadata must serialize as an object");
        if (encoder.encode(json).length > 10240)
          throw new RangeError("Semantic metadata exceeds 10 KiB");
        const type = SemanticIndexMetadataSchema.parse(JSON.parse(json)).type;
        if (typeof type === "string" && type.includes("\0"))
          throw new TypeError("Semantic type cannot contain NUL");
        return {
          id,
          values,
          json,
          type: typeof type === "string" ? type : null,
        };
      });
      await use(true, async (tx) => {
        for (const row of rows)
          await tx.run(
            "INSERT INTO search.vectors(index_name,id,embedding,metadata,type_value) VALUES (?,?,?::real[],?,?) ON CONFLICT(index_name,id) DO UPDATE SET embedding=excluded.embedding,metadata=excluded.metadata,type_value=excluded.type_value",
            [name, row.id, row.values, row.json, row.type],
          );
      });
      return { mutationId: randomUUID() };
    },
    async deleteByIds(input) {
      if (!Array.isArray(input) || input.length > 100)
        throw new RangeError("Semantic deletes accept at most 100 ids");
      const ids = input.map((id) => text(id, 64, "vector id"));
      await use(true, (tx) =>
        tx.run(
          "DELETE FROM search.vectors WHERE index_name=? AND id=ANY(?::text[])",
          [name, ids],
        ),
      );
      return { mutationId: randomUUID() };
    },
    async query(input, query = {}) {
      const values = vector(input, options.dimensions);
      const topK = query.topK ?? 20;
      if (!Number.isSafeInteger(topK) || topK < 1 || topK > 20)
        throw new RangeError("Semantic topK must be 1 to 20");
      if (query.namespace)
        throw new TypeError(
          "Native semantic namespaces use separate index names",
        );
      if (query.returnMetadata === "indexed")
        throw new TypeError("Native semantic metadata supports all or none");
      const types = typeFilter(query.filter);
      const norm = Math.sqrt(
        values.reduce((sum, value) => sum + value * value, 0),
      );
      const rows = await use(false, (tx) =>
        tx.query<MatchRow>(
          `SELECT v.id,v.embedding,v.metadata,CASE WHEN v.norm=0 OR ?::double precision=0 THEN 0 ELSE
          greatest(-1::double precision,least(1::double precision,
            (SELECT sum(a.value::double precision*b.value::double precision)
             FROM unnest(v.embedding) WITH ORDINALITY AS a(value,ordinal)
             JOIN unnest(?::real[]) WITH ORDINALITY AS b(value,ordinal) USING(ordinal)) / (v.norm*?::double precision))) END AS score
         FROM search.vectors v WHERE v.index_name=? AND (?::text[] IS NULL OR v.type_value=ANY(?::text[]))
         ORDER BY score DESC,v.id COLLATE "C" LIMIT ?`,
          [norm, values, norm, name, types, types, topK],
        ),
      );
      const result: VectorizeMatch[] = rows.map((row) => ({
        id: row.id,
        score: row.score,
        ...(query.returnValues ? { values: row.embedding } : {}),
        ...(query.returnMetadata === true || query.returnMetadata === "all"
          ? {
              metadata: SemanticIndexMetadataSchema.parse(
                JSON.parse(row.metadata),
              ) as Record<string, VectorizeVectorMetadata>,
            }
          : {}),
      }));
      return { matches: result, count: result.length };
    },
  };
}
