import { z } from "zod";
import type { D1StoreBinding } from "./d1-store.ts";
import { timingSafeEqual } from "./webhooks.ts";

const integer = z.number().int().nonnegative().safe();
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const network = z.enum(["mainnet", "testnet"]);
const text = z.string().max(8192).nullable();
const number = z.number().int().safe().nullable();
const row = z.tuple([number, text, text, text, number, number, number, number]);
const source = z.strictObject({
  network,
  table: z.literal("blocks"),
  bucket: z.string().min(1).max(128),
  key: z.string().min(1).max(8192),
  etag: z.string().min(1).max(256),
  bytes: integer.min(1),
  rows: integer.min(1),
});
const Input = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("status"),
    network,
    after: integer.default(0),
    generation: hash.optional(),
  }),
  z.strictObject({ kind: z.literal("begin"), identity: hash, source }),
  z.strictObject({
    kind: z.literal("chunk"),
    identity: hash,
    start: integer,
    rows: z.array(row).min(1).max(4000),
  }),
  z.strictObject({
    kind: z.literal("publish"),
    network,
    table_uuid: z.string().uuid(),
    snapshot: z.string().regex(/^[0-9]+$/),
    sequence: integer,
    generated_at: integer,
    source_rows: integer,
    sources: z.array(hash).max(32768),
    coverage: z.string().max(8192).nullable(),
  }),
]);
type Input = z.infer<typeof Input>;
interface SyncEnv {
  D1_RETAINED_BLOCKS?: D1StoreBinding;
  RETAINED_BLOCKS_SYNC_SECRET?: string;
}
interface Source {
  id: number;
  network: number;
  source: string;
  expected_rows: number;
  received_rows: number;
}
const response = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });
const fail = (status: number, error: string) => response(status, { error });

async function inputBody(request: Request): Promise<unknown> {
  if (!request.body) return null;
  const reader = request.body.getReader(),
    decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let text = "",
    bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 1024 * 1024) {
        await reader.cancel();
        throw new Error("body budget exceeded");
      }
      text += decoder.decode(part.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    reader.releaseLock();
  }
}
async function digest(value: unknown): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(value)),
      ),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
async function begin(
  db: D1StoreBinding,
  input: Extract<Input, { kind: "begin" }>,
): Promise<Response> {
  const descriptor = JSON.stringify(input.source),
    net = input.source.network === "mainnet" ? 0 : 1;
  const result = await db.batch<Source>([
    db
      .prepare(
        "INSERT INTO history_block_sources(identity,network,source,expected_rows) VALUES(?,?,?,?) ON CONFLICT(identity) DO NOTHING",
      )
      .bind(input.identity, net, descriptor, input.source.rows),
    db
      .prepare("SELECT * FROM history_block_sources WHERE identity=?")
      .bind(input.identity),
  ]);
  const stored = result[1]!.results[0]!;
  if (stored.source !== descriptor)
    return fail(409, "source identity conflict");
  return response(200, {
    received_rows: stored.received_rows,
    expected_rows: stored.expected_rows,
  });
}
async function chunk(
  db: D1StoreBinding,
  input: Extract<Input, { kind: "chunk" }>,
): Promise<Response> {
  const source = await db
    .prepare("SELECT * FROM history_block_sources WHERE identity=?")
    .bind(input.identity)
    .first<Source>();
  if (!source) return fail(404, "source is not registered");
  const end = input.start + input.rows.length;
  if (end > source.expected_rows || input.start > source.received_rows)
    return fail(409, "chunk exceeds source or skips rows");
  const sha = await digest(input.rows);
  const receipt = () =>
    db
      .prepare(
        "SELECT rows,digest FROM history_block_chunks WHERE source_id=? AND start_row=?",
      )
      .bind(source.id, input.start);
  if (input.start < source.received_rows) {
    const prior = await receipt().first<{ rows: number; digest: string }>();
    return prior?.digest === sha && prior.rows === input.rows.length
      ? response(200, { received_rows: source.received_rows })
      : fail(409, "chunk identity conflict");
  }
  const json = JSON.stringify(input.rows),
    guard =
      "EXISTS(SELECT 1 FROM history_block_sources WHERE id=? AND received_rows=?)";
  const result = await db.batch([
    db
      .prepare(
        `INSERT INTO history_block_authors(address) SELECT DISTINCT json_extract(value,'$[3]') FROM json_each(?) WHERE json_extract(value,'$[3]') IS NOT NULL AND ${guard} ON CONFLICT(address) DO NOTHING`,
      )
      .bind(json, source.id, input.start),
    ...(
      [
        ["events", 5],
        ["extrinsics", 4],
      ] as const
    ).map(([kind, column]) =>
      db
        .prepare(
          `INSERT INTO history_block_source_counts(source_id,kind,value,rows) SELECT ?,?,json_extract(value,'$[${column}]'),COUNT(*) FROM json_each(?) WHERE json_extract(value,'$[${column}]') IS NOT NULL AND ${guard} GROUP BY json_extract(value,'$[${column}]') ON CONFLICT(source_id,kind,value) DO UPDATE SET rows=history_block_source_counts.rows+excluded.rows`,
        )
        .bind(source.id, kind, json, source.id, input.start),
    ),
    db
      .prepare(
        `INSERT INTO history_blocks SELECT ?,?,?+CAST(key AS INTEGER),json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]'),(SELECT id FROM history_block_authors WHERE address=json_extract(value,'$[3]')),json_extract(value,'$[4]'),json_extract(value,'$[5]'),json_extract(value,'$[6]'),json_extract(value,'$[7]') FROM json_each(?) WHERE ${guard}`,
      )
      .bind(
        source.network,
        source.id,
        input.start,
        json,
        source.id,
        input.start,
      ),
    db
      .prepare(`INSERT INTO history_block_chunks SELECT ?,?,?,? WHERE ${guard}`)
      .bind(
        source.id,
        input.start,
        input.rows.length,
        sha,
        source.id,
        input.start,
      ),
    db
      .prepare(
        "UPDATE history_block_sources SET received_rows=? WHERE id=? AND received_rows=?",
      )
      .bind(end, source.id, input.start),
    receipt(),
  ]);
  const proof = result[result.length - 1]!.results[0] as {
    rows: number;
    digest: string;
  };
  if (proof.digest !== sha || proof.rows !== input.rows.length)
    return fail(409, "concurrent chunk identity conflict");
  return response(200, { received_rows: end });
}
async function publish(
  db: D1StoreBinding,
  input: Extract<Input, { kind: "publish" }>,
  now: number,
): Promise<Response> {
  const generation = await digest(input);
  if (
    new Set(input.sources).size !== input.sources.length ||
    input.generated_at > now ||
    now - input.generated_at > 7200000
  )
    return fail(400, "snapshot identity or freshness invalid");
  const net = input.network === "mainnet" ? 0 : 1,
    ids = JSON.stringify(input.sources);
  const [census, previous] = await db.batch([
    db
      .prepare(
        "SELECT COUNT(*) AS files,COALESCE(SUM(expected_rows),0) AS rows FROM history_block_sources WHERE network=? AND identity IN (SELECT value FROM json_each(?)) AND received_rows=expected_rows",
      )
      .bind(net, ids),
    db.prepare("SELECT * FROM history_block_state WHERE network=?").bind(net),
  ]);
  const counts = census!.results[0] as { files: number; rows: number };
  if (
    counts.files !== input.sources.length ||
    counts.rows !== input.source_rows
  )
    return fail(409, "snapshot source census incomplete");
  const prior = previous!.results[0] as
    | {
        generation: string;
        sequence: number;
        generated_at: number;
        table_uuid: string;
        snapshot: string;
      }
    | undefined;
  if (
    prior &&
    (prior.sequence > input.sequence ||
      prior.generated_at > input.generated_at ||
      prior.table_uuid !== input.table_uuid ||
      (prior.sequence === input.sequence && prior.snapshot !== input.snapshot))
  )
    return fail(409, "snapshot cannot regress or replace its table identity");
  const expected = prior?.generation ?? "",
    guard =
      "NOT EXISTS(SELECT 1 FROM history_block_state WHERE network=? AND generation<>?)";
  const result = await db.batch([
    db
      .prepare(
        `UPDATE history_block_sources SET active=CASE WHEN identity IN(SELECT value FROM json_each(?)) THEN 1 ELSE 0 END WHERE network=? AND ${guard}`,
      )
      .bind(ids, net, net, expected),
    db
      .prepare(`DELETE FROM history_block_counts WHERE network=? AND ${guard}`)
      .bind(net, net, expected),
    db
      .prepare(
        `INSERT INTO history_block_counts SELECT ?,c.kind,c.value,SUM(c.rows) FROM history_block_source_counts c JOIN history_block_sources s ON s.id=c.source_id WHERE s.network=? AND s.active=1 AND ${guard} GROUP BY c.kind,c.value`,
      )
      .bind(net, net, net, expected),
    db
      .prepare(
        `INSERT INTO history_block_state SELECT ?,?,?,?,?,?,?,?,? WHERE ${guard} ON CONFLICT(network) DO UPDATE SET generation=excluded.generation,table_uuid=excluded.table_uuid,snapshot=excluded.snapshot,sequence=excluded.sequence,generated_at=excluded.generated_at,source_rows=excluded.source_rows,source_files=excluded.source_files,coverage=excluded.coverage`,
      )
      .bind(
        net,
        generation,
        input.table_uuid,
        input.snapshot,
        input.sequence,
        input.generated_at,
        input.source_rows,
        input.sources.length,
        input.coverage,
        net,
        expected,
      ),
    db
      .prepare("SELECT generation FROM history_block_state WHERE network=?")
      .bind(net),
  ]);
  if (
    (result[4]!.results[0] as { generation?: string } | undefined)
      ?.generation !== generation
  )
    return fail(409, "snapshot publication raced another publisher");
  return response(200, {
    generation,
    source_rows: input.source_rows,
    source_files: input.sources.length,
  });
}
export async function handleRetainedBlocksSync(
  request: Request,
  env: SyncEnv,
  now = Date.now(),
): Promise<Response> {
  if (!env.RETAINED_BLOCKS_SYNC_SECRET || !env.D1_RETAINED_BLOCKS)
    return fail(503, "retained blocks sync is not provisioned");
  if (
    !timingSafeEqual(
      request.headers.get("x-retained-blocks-sync-token"),
      env.RETAINED_BLOCKS_SYNC_SECRET,
    )
  )
    return fail(401, "invalid retained blocks sync credential");
  if (request.method !== "POST")
    return fail(405, "retained blocks sync requires POST");
  const parsed = Input.safeParse(await inputBody(request).catch(() => null));
  if (!parsed.success) return fail(400, "invalid retained blocks sync request");
  try {
    const input = parsed.data,
      db = env.D1_RETAINED_BLOCKS;
    if (input.kind === "status") {
      const net = input.network === "mainnet" ? 0 : 1;
      const [state, rows] = await db.batch([
        db
          .prepare("SELECT * FROM history_block_state WHERE network=?")
          .bind(net),
        db
          .prepare(
            "SELECT id,identity,source,expected_rows,received_rows FROM history_block_sources WHERE network=? AND active=1 AND id>? ORDER BY id LIMIT 201",
          )
          .bind(net, input.after),
      ]);
      const selected = state!.results[0] as { generation: string } | undefined;
      if (
        input.generation !== undefined &&
        input.generation !== selected?.generation
      )
        return fail(409, "snapshot changed during status pagination");
      const sources = rows!.results.slice(0, 200) as { id: number }[];
      return response(200, {
        state: selected ?? null,
        sources,
        next_cursor: rows!.results.length > 200 ? sources[199]!.id : null,
      });
    }
    if (input.kind === "begin") return await begin(db, input);
    if (input.kind === "chunk") return await chunk(db, input);
    return await publish(db, input, now);
  } catch {
    return fail(
      503,
      "retained blocks sync failed; verify receipt before retrying",
    );
  }
}
