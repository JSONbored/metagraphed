// Protected native D1 export protocol for the existing archive jobs (#12184).
// A revision is committed with every selected family write. Each page's data
// and revision share one D1 batch, and a final check precedes archive append.
import { z } from "zod";
import { timingSafeEqual } from "./webhooks.ts";
import { D1_EXPORT_TABLES } from "./d1-export-tables.ts";
import { D1_EXPORT_COLUMNS } from "./d1-export-columns.ts";
import { selectedD1Store, type D1StoreBinding } from "./d1-store.ts";
const scalar = z.union([z.string().max(2048), z.number().safe()]);
const RequestSchema = z
  .object({
    table: z.string(),
    kind: z.enum(["schema", "revision", "days", "rows"]),
    columns: z.array(z.string()).min(1).max(64).optional(),
    day: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    watermark: z.array(z.string()).min(1).max(4).optional(),
    since: z.array(scalar).min(1).max(4).optional(),
    cursor: z.array(scalar).min(1).max(4).optional(),
    revision: z.number().int().nonnegative().safe().optional(),
  })
  .strict();
const BOOLEANS = new Set(
  "active validator_permit is_immunity_period found is_set predates_capture enabled previous_enabled registration_allowed commit_reveal_enabled liquid_alpha_enabled subnet_is_active transfers_enabled bonds_reset_enabled user_liquidity_enabled owner_cut_enabled owner_cut_auto_lock_enabled probe_eligible public_safe emission_enabled subtoken_enabled".split(
    " ",
  ),
);
const MAX_BYTES = 2 * 1024 * 1024;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
interface ExportEnv {
  STATE_EXPORT_SECRET?: string;
  D1_EXPORT_REVISIONS?: string;
  D1_STATE?: D1StoreBinding;
  D1_STATE_TABLES?: string;
}
// The fixed export tables expose SQLite scalar columns, including JSON and
// exact decimal values as TEXT. No blob column is part of this protocol.
interface ExportRow {
  [column: string]: string | number | null;
}
function logicalType(table: string, name: string, type: string): string {
  if (BOOLEANS.has(name)) return "bool";
  if (
    table === "compute_declarations" &&
    ["miner", "validator", "unscoped"].includes(name)
  )
    return "jsonb";
  if (name === "shares") return "numeric";
  if (name === "weights_version" || name === "bonds_moving_avg_raw")
    return "int8";
  if (table === "self_health_daily" && name === "day") return "date";
  return type === "INTEGER" ? "int8" : type === "REAL" ? "float8" : "text";
}
async function body(request: Request): Promise<unknown> {
  if (!request.body) throw new Error("body absent");
  const reader = request.body.getReader();
  let text = "",
    bytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 8192) {
        await reader.cancel();
        throw new Error("body too large");
      }
      text += decoder.decode(part.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    reader.releaseLock();
  }
}
export async function handleD1StateExport(
  request: Request,
  env: ExportEnv,
): Promise<Response> {
  const fail = (status: number, error: string) =>
    Response.json(
      { error },
      { status, headers: { "cache-control": "no-store" } },
    );
  if (!env.STATE_EXPORT_SECRET)
    return fail(503, "state export is not provisioned");
  if (
    !timingSafeEqual(
      request.headers.get("x-state-export-token"),
      env.STATE_EXPORT_SECRET,
    )
  )
    return fail(401, "invalid state export credential");
  if (request.method !== "POST") return fail(405, "state export requires POST");
  const parsed = RequestSchema.safeParse(await body(request).catch(() => null));
  if (!parsed.success || !Object.hasOwn(D1_EXPORT_TABLES, parsed.data.table))
    return fail(400, "invalid export request");
  const input = parsed.data,
    table = input.table,
    plan = D1_EXPORT_TABLES[table]!;
  if (env.D1_EXPORT_REVISIONS !== "enabled")
    return fail(503, "state export revisions are not enabled");
  try {
    if (!selectedD1Store(env, [table]))
      return fail(503, "export source is not owned by D1");
    const db = env.D1_STATE!;
    const schema = (
      await db
        .prepare(`PRAGMA table_info(${quote(table)})`)
        .all<{ name: string; type: string }>()
    ).results;
    // Storage migrations do not implicitly grant archive disclosure access.
    // Unexpected public columns require an explicit policy review first.
    const approved = new Set(D1_EXPORT_COLUMNS[table]!.split(" "));
    if (
      schema.some((row) => !row.name.startsWith("_") && !approved.has(row.name))
    )
      return fail(503, "export schema requires approval");
    const columns = schema
      .filter((row) => approved.has(row.name))
      .map((row) => ({
        name: row.name,
        type: logicalType(table, row.name, row.type),
      }));
    if (!columns.length) throw new Error("export source absent");
    const reply = (value: Record<string, unknown>) =>
      Response.json(
        { version: 1, ...value },
        { headers: { "cache-control": "no-store" } },
      );
    if (input.kind === "schema") return reply({ columns });
    const revisionStatement = db
      .prepare(
        "SELECT coalesce((SELECT revision FROM archive_export_revisions WHERE table_name=?),0) revision",
      )
      .bind(table);
    if (input.kind === "revision") {
      const revision = await revisionStatement.first<number>("revision");
      return input.revision !== undefined && revision !== input.revision
        ? fail(409, "export source changed")
        : reply({ revision });
    }
    if (input.kind === "days") {
      if (!plan.daily) return fail(400, "table has no daily export");
      const source = table === "subnet_snapshots" ? table : `${table}_members`;
      const days = (
        await db
          .prepare(
            `SELECT snapshot_date day,count(*) rows FROM ${source} GROUP BY snapshot_date ORDER BY snapshot_date`,
          )
          .all()
      ).results;
      return reply({ days });
    }
    const fields = input.columns;
    if (
      !fields ||
      new Set(fields).size !== fields.length ||
      fields.some((name) => !columns.some((column) => column.name === name))
    )
      return fail(400, "invalid export columns");
    if (
      (input.cursor &&
        (input.cursor.length !== plan.keys.length ||
          input.revision === undefined ||
          (input.day !== undefined && input.cursor[0] !== input.day))) ||
      (input.day && !plan.daily)
    )
      return fail(400, "invalid export cursor or day");
    if (
      (input.watermark || input.since) &&
      (JSON.stringify(input.watermark) !== JSON.stringify(plan.watermark) ||
        input.since?.length !== plan.watermark?.length)
    )
      return fail(400, "invalid export watermark");
    const where: string[] = [],
      values: (string | number)[] = [];
    if (input.day) {
      where.push("snapshot_date = ?");
      values.push(input.day);
    }
    if (input.since) {
      where.push(
        `(${plan.watermark!.join(",")}) > (${input.since.map(() => "?").join(",")})`,
      );
      values.push(...input.since);
    }
    if (input.cursor) {
      // Remove the already-fixed day from the comparison. Keeping it in a
      // tuple makes SQLite restart at the day's first member on every page.
      const keys = input.day ? plan.keys.slice(1) : plan.keys;
      const cursor = input.day ? input.cursor.slice(1) : input.cursor;
      where.push(`(${keys.join(",")}) > (${cursor.map(() => "?").join(",")})`);
      values.push(...cursor);
    }
    const statement = db
      .prepare(
        `SELECT ${fields.map(quote).join(",")},json_array(${plan.keys.join(",")}) AS _cursor FROM ${quote(table)} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${plan.keys.join(",")} LIMIT 2001`,
      )
      .bind(...values);
    const results = await db.batch<ExportRow>([revisionStatement, statement]);
    const revision = (results[0]!.results[0] as { revision: number }).revision;
    if (input.revision !== undefined && revision !== input.revision)
      return fail(409, "export source changed");
    const sourceRows = results[1]!.results;
    const rows: unknown[][] = [];
    let bytes = 0;
    for (const row of sourceRows.slice(0, 2000)) {
      const projected = fields.map((field) => row[field]);
      bytes +=
        new TextEncoder().encode(JSON.stringify(projected)).byteLength + 1;
      if (bytes > MAX_BYTES) break;
      rows.push(projected);
    }
    if (sourceRows.length && !rows.length)
      return fail(413, "export row exceeds byte budget");
    const next_cursor =
      sourceRows.length > rows.length
        ? JSON.parse(sourceRows[rows.length - 1]!._cursor as string)
        : null;
    return reply({ revision, rows, next_cursor });
  } catch {
    return fail(503, "D1 export unavailable; no snapshot was acknowledged");
  }
}
