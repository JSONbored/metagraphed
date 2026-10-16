import { boundedInternalJson, internalJson } from "./internal-json.ts";
// Revision and page data share one batch; archive append checks it again.
import { z } from "zod";
import { timingSafeEqual } from "./webhooks.ts";
import { D1_EXPORT_TABLES } from "./d1-export-tables.ts";
import { D1_EXPORT_COLUMNS } from "./d1-export-columns.ts";
import { handleNativeHistoryExport } from "./native-history-export.ts";
import { handleRootBasketExport } from "./root-basket-export.ts";
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
    revision_scope: z.literal("day").optional(),
    encoding: z.literal("lossless-v1").optional(),
  })
  .strict();
const BOOLEANS = new Set(
  "active validator_permit is_immunity_period found is_set predates_capture enabled previous_enabled registration_allowed commit_reveal_enabled liquid_alpha_enabled subnet_is_active transfers_enabled bonds_reset_enabled user_liquidity_enabled owner_cut_enabled owner_cut_auto_lock_enabled probe_eligible public_safe emission_enabled subtoken_enabled".split(
    " ",
  ),
);
const INTEGER_FIELDS = new Set(
  "netuid uid captured_at updated_at block_number registered_at_block".split(
    " ",
  ),
);
const FLOAT_FIELDS = new Set(
  "rank trust validator_trust consensus incentive dividends emission_tao stake_tao take".split(
    " ",
  ),
);
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_LOSSLESS_ROWS = 2_000_000;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
// Encode before D1 crosses the JavaScript number boundary. A view can hold
// either INTEGER 1 or TEXT '1'; its PRAGMA type alone cannot distinguish them.
const losslessCell = (expression: string) =>
  `json_object('storage',typeof(${expression}),'value',CASE typeof(${expression}) WHEN 'integer' THEN CAST(${expression} AS TEXT) WHEN 'real' THEN printf('%!.26g',${expression}) WHEN 'blob' THEN hex(${expression}) ELSE ${expression} END)`;
function createCellSchema() {
  return z.discriminatedUnion("storage", [
    z.object({ storage: z.literal("null"), value: z.null() }).strict(),
    z
      .object({
        storage: z.enum(["integer", "real", "text", "blob"]),
        value: z.string(),
      })
      .strict(),
  ]);
}
const cellSchema = createCellSchema();
function checkedCell(encoded: string) {
  const cell = cellSchema.parse(JSON.parse(encoded));
  if (cell.storage === "real" && !Number.isFinite(Number(cell.value)))
    throw new Error("non-finite export cell");
  return cell;
}
interface ExportEnv {
  STATE_EXPORT_SECRET?: string;
  D1_EXPORT_REVISIONS?: string;
  D1_STATE?: D1StoreBinding;
  D1_STATE_TABLES?: string;
}
// JSON and exact decimals are TEXT; exports contain no blobs.
interface ExportRow {
  [column: string]: string | number | null;
}
function logicalType(table: string, name: string, type: string): string {
  if (BOOLEANS.has(name)) return "bool";
  // SQLite cannot infer column types for JSON-extract views. Retained rows
  // can contain either numeric JSON strings or numbers, so Arrow needs the
  // same explicit logical types as the original neuron row contract.
  if (["neurons", "neuron_daily", "account_position_daily"].includes(table)) {
    if (INTEGER_FIELDS.has(name)) return "int8";
    if (FLOAT_FIELDS.has(name)) return "float8";
  }
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
export async function handleD1StateExport(
  request: Request,
  env: ExportEnv,
): Promise<Response> {
  const fail = (status: number, error: string) =>
    internalJson({ error }, status);
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
  const inputBody = await boundedInternalJson(request, 8192).catch(() => null);
  if (inputBody && typeof inputBody === "object") {
    const kind = (inputBody as { kind?: unknown }).kind;
    if (kind === "basket") return handleRootBasketExport(inputBody, env);
    if (kind === "native-history")
      return handleNativeHistoryExport(inputBody, env);
  }
  const parsed = RequestSchema.safeParse(inputBody);
  if (!parsed.success || !Object.hasOwn(D1_EXPORT_TABLES, parsed.data.table))
    return fail(400, "invalid export request");
  const input = parsed.data,
    table = input.table,
    plan = D1_EXPORT_TABLES[table]!;
  const lossless = input.encoding === "lossless-v1";
  if (
    lossless &&
    (input.day ||
      input.revision_scope ||
      input.watermark ||
      input.since ||
      input.kind === "days")
  )
    return fail(400, "lossless export requires the full approved projection");
  const dayScope = input.revision_scope === "day";
  if (
    dayScope &&
    (!plan.daily ||
      !input.day ||
      input.day >= new Date().toISOString().slice(0, 10) ||
      !["rows", "revision"].includes(input.kind))
  )
    return fail(400, "day revisions require a closed daily partition");
  if (env.D1_EXPORT_REVISIONS !== "enabled")
    return fail(503, "state export revisions are not enabled");
  try {
    if (!selectedD1Store(env, [table]))
      return fail(503, "export source is not owned by D1");
    const db = env.D1_STATE!;
    const revisionStatement = db
      .prepare(
        "SELECT coalesce((SELECT revision FROM archive_export_revisions WHERE table_name=?),0) revision, EXISTS(SELECT 1 FROM archive_export_revisions WHERE table_name='__closed_day_revisions_v1') day_revisions",
      )
      .bind(dayScope ? `${table}/${input.day}` : table);
    const schemaStatement = db.prepare(`PRAGMA table_info(${quote(table)})`);
    const dependencies = [
      table,
      ...(["neurons", "neuron_daily", "account_position_daily"].includes(table)
        ? [`${table}_members`, `${table}_documents`]
        : []),
    ];
    const definitions = db
      .prepare(
        `SELECT name,sql FROM sqlite_schema WHERE name IN (${dependencies.map(() => "?").join(",")}) ORDER BY name`,
      )
      .bind(...dependencies);
    const filter =
      table === "subnet_lifecycle" ? " WHERE _invalidated_at IS NULL" : "";
    const metadata = lossless
      ? await db.batch<ExportRow>([
          schemaStatement,
          definitions,
          revisionStatement,
          ...(input.kind === "schema"
            ? [
                db.prepare(
                  `SELECT COUNT(*) rows FROM (SELECT 1 FROM ${quote(table)}${filter} LIMIT ${MAX_LOSSLESS_ROWS + 1})`,
                ),
              ]
            : []),
        ])
      : null;
    type PhysicalColumn = {
      name: string;
      type: string;
      notnull: number;
      pk: number;
    };
    const schema = metadata
      ? z
          .array(
            z.object({
              name: z.string(),
              type: z.string(),
              notnull: z.union([z.literal(0), z.literal(1)]),
              pk: z.number().int().nonnegative(),
            }),
          )
          .parse(metadata[0]!.results)
      : (await schemaStatement.all<PhysicalColumn>()).results;
    // Storage migrations cannot authorize new disclosure fields.
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
        ...(lossless
          ? {
              sqlite_type: row.type,
              not_null: row.notnull === 1,
              primary_key: row.pk,
            }
          : {}),
      }));
    // The exporter can precede the additive receiver DDL. Approve both exact
    // physical generations, preserving the original seven-column recovery
    // corpus. A partially applied evidence pair cannot describe a snapshot.
    const legacyNominator =
      table === "nominator_positions" &&
      JSON.stringify(columns.map((column) => column.name)) ===
        JSON.stringify(
          D1_EXPORT_COLUMNS.nominator_positions!.split(" ").slice(0, -2),
        );
    if (
      !columns.length ||
      ((lossless || table === "nominator_positions") &&
        columns.length !== approved.size &&
        !legacyNominator)
    )
      throw new Error("export source schema is incomplete");
    const sourceDefinitions = metadata?.[1]!.results;
    if (lossless && sourceDefinitions!.length !== dependencies.length)
      throw new Error("export projection dependencies are incomplete");
    // Bind view SQL and the actual serving codec/filter, not only PRAGMA names.
    // Only a digest crosses the disclosure boundary; private columns do not.
    const projection_sha256 = lossless
      ? Array.from(
          new Uint8Array(
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(
                JSON.stringify([
                  handleD1StateExport.toString(),
                  logicalType.toString(),
                  losslessCell.toString(),
                  createCellSchema.toString(),
                  checkedCell.toString(),
                  quote.toString(),
                  [...BOOLEANS],
                  [...INTEGER_FIELDS],
                  [...FLOAT_FIELDS],
                  plan,
                  [...approved],
                  sourceDefinitions,
                ]),
              ),
            ),
          ),
        )
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("")
      : undefined;
    const reply = (value: Record<string, unknown>) =>
      internalJson({
        version: 1,
        ...(lossless
          ? { encoding: "lossless-v1", table, projection_sha256 }
          : {}),
        ...value,
      });
    if (
      lossless &&
      input.kind === "schema" &&
      (metadata![3]!.results[0]!.rows as number) > MAX_LOSSLESS_ROWS
    )
      return fail(413, "lossless source census exceeds row budget");
    if (input.kind === "schema")
      return reply({
        columns,
        ...(lossless
          ? {
              scope: "approved-application-projection",
              keys: plan.keys,
              revision: metadata![2]!.results[0]!.revision,
              row_count: metadata![3]!.results[0]!.rows,
            }
          : {}),
        day_revisions:
          !!plan.daily &&
          (await revisionStatement.first<number>("day_revisions")) === 1,
      });
    const checkedRevision = (row: ExportRow) => {
      if (dayScope && row.day_revisions !== 1)
        throw new Error("Day revisions are not provisioned");
      return row.revision as number;
    };
    if (input.kind === "revision") {
      const revision = checkedRevision(
        metadata
          ? (metadata[2]!.results[0]! as ExportRow)
          : (await revisionStatement.first<ExportRow>())!,
      );
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
      lossless &&
      JSON.stringify(fields) !== JSON.stringify(columns.map((c) => c.name))
    )
      return fail(
        400,
        "lossless export requires every approved column in schema order",
      );
    if (
      (input.cursor &&
        (input.cursor.length !== plan.keys.length ||
          input.revision === undefined ||
          (input.day !== undefined && input.cursor[0] !== input.day))) ||
      (input.day && !plan.daily)
    )
      return fail(400, "invalid export cursor or day");
    const integerKey = (key: string) =>
      columns.some(
        (c) =>
          c.name === (key === "coalesce(netuid,-1)" ? "netuid" : key) &&
          c.type === "int8",
      );
    if (
      lossless &&
      input.cursor?.some((value, i) => {
        if (typeof value !== "string") return true;
        if (!integerKey(plan.keys[i]!)) return false;
        if (!/^-?(0|[1-9][0-9]*)$/.test(value) || value === "-0") return true;
        const n = BigInt(value);
        return n < -(1n << 63n) || n >= 1n << 63n;
      })
    )
      return fail(400, "invalid lossless cursor");
    if (
      (input.watermark || input.since) &&
      (JSON.stringify(input.watermark) !== JSON.stringify(plan.watermark) ||
        input.since?.length !== plan.watermark?.length)
    )
      return fail(400, "invalid export watermark");
    const where: string[] = [],
      values: (string | number)[] = [];
    if (table === "subnet_lifecycle") where.push("_invalidated_at IS NULL");
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
      where.push(
        `(${keys.join(",")}) > (${cursor.map((_, i) => (lossless && integerKey(keys[i]!) ? "CAST(? AS INTEGER)" : "?")).join(",")})`,
      );
      values.push(...cursor);
    }
    // Retain the qualified analytics optimization. Lossless mode reads the
    // actual approved view so its values agree with the pinned view definition.
    const optimizedNeurons = table === "neurons" && !lossless;
    const projection = fields
      .map((field) => {
        const expression =
          optimizedNeurons &&
          !["netuid", "uid", "hotkey", "coldkey"].includes(field)
            ? `json_extract(metrics,'$[0].${field}')`
            : quote(field);
        if (lossless) return `${losslessCell(expression)} AS ${quote(field)}`;
        return expression === quote(field)
          ? expression
          : `${expression} AS ${quote(field)}`;
      })
      .join(",");
    const cursorSql = `json_array(${plan.keys.map((key) => (lossless ? `CAST(${key} AS TEXT)` : key)).join(",")}) AS _cursor`;
    const effectiveKeys = lossless
      ? `,json_array(${plan.keys.map((key) => losslessCell(key)).join(",")}) AS _lossless_keys`
      : "";
    // ORDER BY an unqualified name would select its encoded output alias.
    // Page by the original SQLite keys, including its nullable-key expression.
    const order = lossless
      ? plan.keys
          .map((key) =>
            key === "coalesce(netuid,-1)"
              ? `coalesce(${quote(table)}.netuid,-1)`
              : `${quote(table)}.${quote(key)}`,
          )
          .join(",")
      : plan.keys.join(",");
    const text = optimizedNeurons
      ? `WITH page AS MATERIALIZED (
         SELECT m.netuid,m.uid,m.hotkey,m.coldkey,
           jsonb_array(jsonb_extract(d.payload,'$."'||m.uid||'"')) AS metrics
         FROM neurons_members m CROSS JOIN neurons_documents d
         ON d.netuid=m.netuid AND d.day='' AND d.shard=m.shard
         ${input.cursor ? "WHERE (m.netuid,m.uid) > (?,?)" : ""}
         ORDER BY m.netuid,m.uid LIMIT 2001)
         SELECT ${projection},${cursorSql}${effectiveKeys} FROM page ORDER BY netuid,uid`
      : `SELECT ${projection},${cursorSql}${effectiveKeys} FROM ${quote(table)} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${order} LIMIT 2001`;
    const statement = db.prepare(text).bind(...values);
    const results = await db.batch<ExportRow>([
      revisionStatement,
      statement,
      ...(lossless ? [definitions] : []),
    ]);
    if (
      lossless &&
      JSON.stringify(results[2]!.results) !== JSON.stringify(sourceDefinitions)
    )
      return fail(409, "export projection changed");
    const revision = checkedRevision(results[0]!.results[0]!);
    if (input.revision !== undefined && revision !== input.revision)
      return fail(409, "export source changed");
    const sourceRows = results[1]!.results;
    const rows: unknown[][] = [];
    const row_keys: unknown[][] = [];
    let bytes = 0;
    for (const row of sourceRows.slice(0, 2000)) {
      const projected = fields.map((field) =>
        lossless ? checkedCell(row[field] as string) : row[field],
      );
      const keys = lossless
        ? z
            .array(cellSchema)
            .length(plan.keys.length)
            .parse(JSON.parse(row._lossless_keys as string))
        : [];
      if (
        lossless &&
        keys.some(
          (cell, i) =>
            cell.storage !== (integerKey(plan.keys[i]!) ? "integer" : "text") ||
            !scalar.safeParse(cell.value).success,
        )
      )
        throw new Error("lossless key cannot resume with the bounded cursor");
      bytes +=
        new TextEncoder().encode(
          JSON.stringify(lossless ? [projected, keys] : projected),
        ).byteLength + 1;
      if (bytes > MAX_BYTES) break;
      rows.push(projected);
      if (lossless) row_keys.push(keys);
    }
    if (sourceRows.length && !rows.length)
      return fail(413, "export row exceeds byte budget");
    const next_cursor =
      sourceRows.length > rows.length
        ? JSON.parse(sourceRows[rows.length - 1]!._cursor as string)
        : null;
    if (
      lossless &&
      next_cursor !== null &&
      new TextEncoder().encode(
        JSON.stringify({ ...input, revision, cursor: next_cursor }),
      ).byteLength > 8192
    )
      return fail(413, "lossless export cursor exceeds request byte budget");
    return reply({
      revision,
      rows,
      next_cursor,
      ...(lossless ? { row_keys } : {}),
    });
  } catch {
    return fail(503, "D1 export unavailable; no snapshot was acknowledged");
  }
}
