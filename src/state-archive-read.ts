import { z } from "zod";
import {
  AccountIdentityHistoryRowSchema,
  SubnetIdentityHistoryRowSchema,
  SubnetHyperparamsHistoryRowSchema,
  SubnetOwnershipHistoryRowSchema,
} from "../schemas-src/lakehouse.ts";
import { artifactBucket, type ArtifactStoreEnv } from "./projection-store.ts";

const rowsByTable = {
  account_identity_history: AccountIdentityHistoryRowSchema.required(),
  subnet_identity_history: SubnetIdentityHistoryRowSchema.required(),
  subnet_hyperparams_history: SubnetHyperparamsHistoryRowSchema.required(),
  subnet_ownership_history: SubnetOwnershipHistoryRowSchema.required(),
};
type StateArchiveTable = keyof typeof rowsByTable;
const MAX_BYTES = 8 * 1024 * 1024;
const Manifest = z.strictObject({
  version: z.literal(1),
  table: z.string(),
  generation: z.string().regex(/^[0-9a-f]{64}$/),
  rowCount: z.number().int().nonnegative().max(100_000),
  source: z.strictObject({
    tableUuid: z.string().min(1),
    snapshot: z.string().regex(/^[0-9]+$/),
    sequence: z.number().int().nonnegative(),
    sources: z
      .array(
        z.strictObject({
          bucket: z.string(),
          key: z.string(),
          bytes: z.number().int().positive(),
          etag: z.string().min(1),
          rows: z.number().int().nonnegative(),
          network: z.literal("mainnet"),
          table: z.string(),
        }),
      )
      .max(10_000),
  }),
  object: z.strictObject({
    key: z.string(),
    etag: z.string().min(1),
    bytes: z.number().int().positive().max(MAX_BYTES),
  }),
});
const Payload = z.strictObject({
  version: z.literal(1),
  table: z.string(),
  generation: z.string(),
  rows: z.array(z.record(z.string(), z.unknown())).max(100_000),
});

/** Undefined means unpublished; a broken selected archive never falls back to SQL. */
export async function readStateArchiveRows(
  env: ArtifactStoreEnv | null | undefined,
  table: StateArchiveTable,
): Promise<Record<string, unknown>[] | null | undefined> {
  const bucket = artifactBucket(env);
  if (!bucket) return undefined;
  const root = `metagraph/state-archive/v1/${table}`;
  try {
    const pointer = await bucket.get(`${root}/current.json`);
    if (!pointer) return undefined;
    if (
      typeof pointer.size !== "number" ||
      pointer.size <= 0 ||
      pointer.size > 1024 * 1024
    )
      return null;
    const parsed = Manifest.safeParse(await pointer.json());
    if (!parsed.success) return null;
    const manifest = parsed.data;
    if (
      manifest.table !== table ||
      manifest.object.key !== `${root}/${manifest.generation}/rows.json` ||
      manifest.source.sources.some((source) => source.table !== table) ||
      manifest.source.sources.reduce(
        (count, source) => count + source.rows,
        0,
      ) !== manifest.rowCount
    )
      return null;
    const object = await bucket.get(manifest.object.key);
    if (
      !object ||
      object.etag !== manifest.object.etag ||
      object.size !== manifest.object.bytes
    )
      return null;
    const body = Payload.safeParse(await object.json());
    if (
      !body.success ||
      body.data.table !== table ||
      body.data.generation !== manifest.generation ||
      body.data.rows.length !== manifest.rowCount
    )
      return null;
    for (const row of body.data.rows)
      if (!rowsByTable[table].safeParse(row).success) return null;
    return body.data.rows;
  } catch {
    return null;
  }
}
