import { createHash } from "node:crypto";
import { EXPORT_PROJECTION } from "../generated/db/export-projection.ts";
import { D1_EXPORT_COLUMNS } from "./d1-export-columns.ts";
import { D1_EXPORT_TABLES } from "./d1-export-tables.ts";
import { logicalType, RequestSchema } from "./d1-state-export.ts";
import { internalJson } from "./internal-json.ts";
import type { NativeSource } from "./native-api-process.ts";
import type { NativeStateExport } from "./native-state-export.ts";
import type { PgTransaction } from "./pg-pool.ts";
import type {
  createSqliteDocumentDecoder,
  SqliteDocumentValue,
} from "./sqlite-document-decoder.ts";
import { sqliteNumberDecimal } from "./sqlite-number.ts";
import type { z } from "zod";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_LOSSLESS_ROWS = 2_000_000;
const VIEWS = new Set(["neurons", "neuron_daily", "account_position_daily"]);
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const fail = (status: number, error: string) => internalJson({ error }, status);
type Decoder = ReturnType<typeof createSqliteDocumentDecoder>;
type Column = readonly [
  name: string,
  type: string,
  notnull: number,
  pk: number,
];
type Input = z.infer<typeof RequestSchema>;
type ExportRecord = Record<string, string | null>;
const metadata: Readonly<Record<string, readonly Column[]>> =
  EXPORT_PROJECTION.tables;

function integerKey(table: string, key: string): boolean {
  const name = key === "coalesce(netuid,-1)" ? "netuid" : key;
  const column = metadata[table]!.find((entry) => entry[0] === name)!;
  return logicalType(table, name, column[1]) === "int8";
}

function storedScalar(value: string | null, type: string): SqliteDocumentValue {
  if (value === null) return null;
  if (type === "boolean") {
    if (value !== "true" && value !== "false")
      throw new Error("Invalid native boolean");
    return value === "true" ? 1n : 0n;
  }
  if (type === "bigint") return BigInt(value);
  if (type === "double precision") return Number(value);
  // The physical-schema check admits only these four representations.
  return value;
}

function exportValue(
  value: SqliteDocumentValue,
  lossless: boolean,
  decoder: Decoder,
): unknown {
  if (!lossless) {
    if (typeof value === "bigint") return Number(value);
    if (typeof value === "number")
      return Number.isFinite(value) ? (value === 0 ? 0 : value) : null;
    if (value instanceof Uint8Array)
      throw new Error("Ordinary export cannot encode a BLOB");
    return value;
  }
  if (value === null) return { storage: "null", value: null };
  if (typeof value === "bigint")
    return { storage: "integer", value: value.toString() };
  if (typeof value === "number")
    return { storage: "real", value: decoder.formatReal(value) };
  if (typeof value === "string") return { storage: "text", value };
  return {
    storage: "blob",
    value: Buffer.from(value).toString("hex").toUpperCase(),
  };
}

function keySql(table: string, key: string, alias: string): string {
  return key === "coalesce(netuid,-1)"
    ? `coalesce(${alias}.netuid,-1)`
    : `${alias}.${quote(key)}`;
}

/** The bound envelope reaches the driver before any unbounded text can. */
async function boundedPage(
  scope: PgTransaction,
  sql: string,
  values: unknown[],
): Promise<{ rows: ExportRecord[]; more: boolean }> {
  const encoded = await scope.query<{ payload: string | null }>(
    `
    WITH page AS MATERIALIZED (${sql}), encoded AS MATERIALIZED (
      SELECT row_number() OVER () AS ordinal,row_to_json(page)::text AS payload FROM page
    ), sizes AS (
      SELECT ordinal,payload,octet_length(payload)+1 AS bytes,
        sum(octet_length(payload)+1) OVER (ORDER BY ordinal) AS total FROM encoded
    ) SELECT CASE WHEN total<=${MAX_SOURCE_BYTES} THEN payload END AS payload FROM sizes
      WHERE total-bytes<${MAX_SOURCE_BYTES} ORDER BY ordinal`,
    values,
  );
  const rows: ExportRecord[] = [];
  let more = false;
  for (const row of encoded) {
    if (row.payload === null) {
      more = true;
      break;
    }
    const parsed: unknown = JSON.parse(row.payload);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Native export source row is invalid");
    const fields: [string, string | null][] = [];
    for (const [name, value] of Object.entries(parsed)) {
      if (value !== null && typeof value !== "string")
        throw new Error("Native export source field is invalid");
      fields.push([name, value]);
    }
    rows.push(Object.fromEntries(fields));
  }
  return { rows, more };
}

/** Complete native table exports share the process pool and pinned JSON decoder. */
export function createPgStateExport(
  source: Pick<NativeSource, "schema" | "relations" | "access" | "transaction">,
  decoder: Decoder,
  options: { identity: string },
): NativeStateExport {
  const dependencies = Object.keys(D1_EXPORT_TABLES).flatMap((table) =>
    VIEWS.has(table) ? [`${table}_members`, `${table}_documents`] : [table],
  );
  if (
    source.schema !== "app" ||
    source.access !== "read-write" ||
    !["native_export_revisions", ...dependencies].every((name) =>
      source.relations.includes(name),
    ) ||
    !/^urn:metagraphed:export:[a-z0-9][a-z0-9._-]{0,127}$/.test(
      options.identity,
    )
  )
    throw new TypeError(
      "Native export requires complete source ownership and identity",
    );
  const transaction = source.transaction.bind(source);
  const projectionCode = [
    createPgStateExport.toString(),
    boundedPage.toString(),
    keySql.toString(),
    storedScalar.toString(),
    exportValue.toString(),
    integerKey.toString(),
    logicalType.toString(),
    sqliteNumberDecimal.toString(),
    quote.toString(),
    MAX_BYTES,
    MAX_SOURCE_BYTES,
    MAX_LOSSLESS_ROWS,
    [...VIEWS],
    D1_EXPORT_TABLES,
    D1_EXPORT_COLUMNS,
    EXPORT_PROJECTION,
    decoder.identity,
    decoder.extract.toString(),
    decoder.formatReal.toString(),
    decoder.numericAffinity.toString(),
    decoder.textAffinity.toString(),
    options.identity,
  ];
  const baseProjection = createHash("sha256")
    .update(JSON.stringify(projectionCode))
    .digest("hex");

  return {
    async export(body) {
      const parsed = RequestSchema.safeParse(body);
      if (
        !parsed.success ||
        !Object.hasOwn(D1_EXPORT_TABLES, parsed.data.table)
      )
        return fail(400, "invalid export request");
      const input: Input = parsed.data,
        table = input.table,
        plan = D1_EXPORT_TABLES[table]!;
      let projection = baseProjection;
      const lossless = input.encoding === "lossless-v1",
        dayScope = input.revision_scope === "day";
      const today = new Date().toISOString().slice(0, 10);
      if (
        lossless &&
        (input.day ||
          input.revision_scope ||
          input.watermark ||
          input.since ||
          input.kind === "days")
      )
        return fail(
          400,
          "lossless export requires the full approved projection",
        );
      if (
        dayScope &&
        (!plan.daily ||
          !input.day ||
          input.day >= today ||
          !["rows", "revision"].includes(input.kind))
      )
        return fail(400, "day revisions require a closed daily partition");
      const columns = metadata[table]!.map(([name, type, notnull, pk]) => ({
        name,
        type: logicalType(table, name, type),
        ...(lossless
          ? { sqlite_type: type, not_null: notnull === 1, primary_key: pk }
          : {}),
      }));
      const reply = (value: Record<string, unknown>) =>
        internalJson({
          version: 1,
          ...(lossless
            ? { encoding: "lossless-v1", table, projection_sha256: projection }
            : {}),
          ...value,
        });
      if (input.kind === "days" && !plan.daily)
        return fail(400, "table has no daily export");
      const fields = input.columns;
      if (input.kind === "rows") {
        if (
          !fields ||
          new Set(fields).size !== fields.length ||
          fields.some((name) => !columns.some((column) => column.name === name))
        )
          return fail(400, "invalid export columns");
        if (
          lossless &&
          JSON.stringify(fields) !==
            JSON.stringify(columns.map((column) => column.name))
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
        if (
          (input.watermark || input.since) &&
          (JSON.stringify(input.watermark) !== JSON.stringify(plan.watermark) ||
            input.since?.length !== plan.watermark?.length)
        )
          return fail(400, "invalid export watermark");
        if (
          lossless &&
          input.cursor?.some(
            (value, index) =>
              typeof value !== "string" ||
              (integerKey(table, plan.keys[index]!) &&
                (!/^-?(0|[1-9][0-9]*)$/.test(value) ||
                  value === "-0" ||
                  BigInt(value) < -(1n << 63n) ||
                  BigInt(value) >= 1n << 63n)),
          )
        )
          return fail(400, "invalid lossless cursor");
      }
      try {
        return await transaction(
          async (scope) => {
            const view = VIEWS.has(table),
              alias = view ? "m" : "t";
            const dependencies = view
              ? [`${table}_members`, `${table}_documents`]
              : [table];
            // TRUNCATE is not MVCC-safe. Take these finite page locks before
            // reading the revision, then use fresh READ COMMITTED snapshots.
            // This also excludes schema/trigger changes during the page.
            await scope.query(
              `LOCK TABLE ${dependencies.map((name) => `app.${quote(name)}`).join(",")} IN SHARE MODE`,
            );
            const revisionRow = await scope.first<{
              revision: string;
              day_revision: string | null;
            }>(
              `
            SELECT root.revision::text,selected.revision::text AS day_revision
            FROM app.native_export_revisions root LEFT JOIN app.native_export_revisions selected ON selected.family=$2
            WHERE root.family=$1`,
              [table, `${table}/${input.day ?? ""}`],
            );
            if (!revisionRow)
              throw new Error("Native export revision owner is missing");
            const revision = Number(
              dayScope
                ? (revisionRow.day_revision ?? "0")
                : revisionRow.revision,
            );
            if (!Number.isSafeInteger(revision) || revision < 0)
              throw new Error("Invalid native export revision");
            if (
              input.kind !== "schema" &&
              input.revision !== undefined &&
              input.revision !== revision
            )
              return fail(409, "export source changed");

            const triggers = await scope.query<{
              table: string;
              name: string;
              type: number;
              enabled: string;
              function: string;
              args: string;
            }>(
              `
            SELECT c.relname AS table,t.tgname AS name,t.tgtype AS type,t.tgenabled AS enabled,p.proname AS function,encode(t.tgargs,'hex') AS args
            FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid
            WHERE n.nspname='app' AND p.pronamespace='app'::regnamespace AND c.relname=ANY($1::text[])
              AND t.tgname IN ('native_export_revision','native_export_closed_day')`,
              [dependencies],
            );
            for (const dependency of dependencies) {
              const normal = triggers.find(
                (trigger) =>
                  trigger.table === dependency &&
                  trigger.name === "native_export_revision",
              );
              if (
                !normal ||
                normal.type !== 62 ||
                !["O", "A"].includes(normal.enabled) ||
                normal.function !== "native_export_bump" ||
                normal.args !== Buffer.from(table + "\0").toString("hex")
              )
                throw new Error(
                  "Native export mutation tracking is unavailable",
                );
              if (plan.daily) {
                const day = triggers.find(
                  (trigger) =>
                    trigger.table === dependency &&
                    trigger.name === "native_export_closed_day",
                );
                const column = dependency.endsWith("_documents")
                  ? "day"
                  : "snapshot_date";
                if (
                  !day ||
                  day.type !== 29 ||
                  !["O", "A"].includes(day.enabled) ||
                  day.function !== "native_export_day_bump" ||
                  day.args !==
                    Buffer.from(table + "\0" + column + "\0").toString("hex")
                )
                  throw new Error("Native closed-day tracking is unavailable");
              }
            }
            const from = view
              ? `app.${quote(table + "_members")} m JOIN app.${quote(table + "_documents")} d ON d.netuid=m.netuid AND d.shard=m.shard AND ${table === "neurons" ? "d.day=''" : "d.day=m.snapshot_date"}`
              : `app.${quote(table)} t`;
            const physical = view
              ? []
              : await scope.query<{ name: string; type: string }>(
                  `
            SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type FROM pg_attribute a
            WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,
                  [`app.${table}`],
                );
            projection = createHash("sha256")
              .update(
                JSON.stringify([
                  baseProjection,
                  table,
                  physical,
                  plan,
                  columns,
                ]),
              )
              .digest("hex");
            if (
              !view &&
              (physical.some(
                (column) =>
                  !column.name.startsWith("_") &&
                  !D1_EXPORT_COLUMNS[table]!.split(" ").includes(column.name),
              ) ||
                columns.some(
                  (column) =>
                    !physical.some((field) => field.name === column.name),
                ))
            )
              throw new Error("Native export schema requires approval");
            for (const column of physical) {
              if (column.name.startsWith("_")) continue;
              const original = metadata[table]!.find(
                (item) => item[0] === column.name,
              );
              if (!original)
                throw new Error("Native export projection requires approval");
              const expected =
                original[1] === "TEXT"
                  ? "text"
                  : original[1] === "REAL"
                    ? "double precision"
                    : logicalType(table, column.name, original[1]) === "bool"
                      ? "boolean"
                      : "bigint";
              if (column.type !== expected)
                throw new Error("Native export column type requires approval");
            }
            if (input.kind === "schema") {
              const count = lossless
                ? await scope.first<{ count: string }>(
                    `SELECT count(*)::text FROM (SELECT 1 FROM ${from} ${table === "subnet_lifecycle" ? "WHERE t._invalidated_at IS NULL" : ""} LIMIT ${MAX_LOSSLESS_ROWS + 1}) source`,
                  )
                : null;
              const rowCount = Number(count?.count ?? 0);
              if (
                lossless &&
                (!count || !Number.isSafeInteger(rowCount) || rowCount < 0)
              )
                throw new Error("Native export source census is invalid");
              if (rowCount > MAX_LOSSLESS_ROWS)
                return fail(413, "lossless source census exceeds row budget");
              return reply({
                columns,
                day_revisions: !!plan.daily,
                ...(lossless
                  ? {
                      scope: "approved-application-projection",
                      keys: plan.keys,
                      revision,
                      row_count: rowCount,
                    }
                  : {}),
              });
            }
            if (input.kind === "revision") return reply({ revision });
            if (input.kind === "days") {
              const daily =
                table === "subnet_snapshots" ? table : `${table}_members`;
              const page = await boundedPage(
                scope,
                `SELECT snapshot_date AS day,count(*)::text AS rows FROM app.${quote(daily)} GROUP BY snapshot_date ORDER BY snapshot_date COLLATE "C" LIMIT ${MAX_LOSSLESS_ROWS + 1}`,
                [],
              );
              const days = page.rows.map((row) => ({
                day: row.day,
                rows: Number(row.rows),
              }));
              if (
                page.more ||
                Buffer.byteLength(JSON.stringify(days)) > MAX_BYTES
              )
                return fail(413, "export day inventory exceeds byte budget");
              return reply({ days });
            }

            const values: unknown[] = [],
              where: string[] = [];
            if (table === "subnet_lifecycle")
              where.push("t._invalidated_at IS NULL");
            if (input.day) {
              values.push(input.day);
              where.push(`${alias}.snapshot_date=$${values.length}`);
            }
            function after(keys: string[], cursor: (string | number)[]) {
              const terms = keys.map((key, index) => {
                const numeric = integerKey(table, key),
                  supplied = cursor[index]!;
                const expression = numeric
                  ? keySql(table, key, alias)
                  : `convert_to(${keySql(table, key, alias)},'UTF8')`;
                let value: string | number | bigint = supplied;
                if (numeric && typeof supplied === "string") {
                  // A computed SQLite key has no INTEGER affinity. Its number
                  // values sort below a text cursor; ordinary columns coerce only
                  // well-formed numeric strings. Lossless cursors cast explicitly.
                  if (
                    (!lossless && key === "coalesce(netuid,-1)") ||
                    !/^[ \t\n\v\f\r]*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[ \t\n\v\f\r]*$/.test(
                      supplied,
                    )
                  )
                    return { greater: "false", equal: "false" };
                  value = decoder.numericAffinity(supplied)!;
                }
                if (
                  numeric &&
                  typeof value === "number" &&
                  !Number.isFinite(value)
                )
                  return {
                    greater: value < 0 ? "true" : "false",
                    equal: "false",
                  };
                const bind = numeric
                  ? typeof value === "bigint"
                    ? value.toString()
                    : sqliteNumberDecimal(Number(value))
                  : typeof supplied === "number"
                    ? decoder.textAffinity(supplied)!
                    : supplied;
                values.push(numeric ? bind : Buffer.from(String(bind)));
                const parameter = `$${values.length}::${numeric ? "numeric" : "bytea"}`;
                return {
                  greater: `${expression}>${parameter}`,
                  equal: `${expression}=${parameter}`,
                };
              });
              where.push(
                "(" +
                  terms
                    .map(
                      (term, index) =>
                        "(" +
                        [
                          ...terms
                            .slice(0, index)
                            .map((previous) => previous.equal),
                          term.greater,
                        ].join(" AND ") +
                        ")",
                    )
                    .join(" OR ") +
                  ")",
              );
            }
            if (input.since) after(plan.watermark!, input.since);
            if (input.cursor)
              after(
                input.day ? plan.keys.slice(1) : plan.keys,
                input.day ? input.cursor.slice(1) : input.cursor,
              );
            const keys = plan.keys.map(
              (key, index) =>
                `${keySql(table, key, alias)}::text AS ${quote(`_key${index}`)}`,
            );
            const order = plan.keys
              .map(
                (key) =>
                  `${keySql(table, key, alias)}${integerKey(table, key) ? "" : ' COLLATE "C"'}`,
              )
              .join(",");
            const identityNames =
              table === "account_position_daily"
                ? ["account", "netuid", "snapshot_date", "shard"]
                : table === "neuron_daily"
                  ? [
                      "netuid",
                      "uid",
                      "hotkey",
                      "coldkey",
                      "snapshot_date",
                      "shard",
                    ]
                  : ["netuid", "uid", "hotkey", "coldkey", "shard"];
            const selected = view
              ? identityNames.map(
                  (name) => `m.${quote(name)}::text AS ${quote(name)}`,
                )
              : fields!.map(
                  (name) => `t.${quote(name)}::text AS ${quote(name)}`,
                );
            const page = await boundedPage(
              scope,
              `SELECT ${[...selected, ...keys].join(",")} FROM ${from} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${order} LIMIT 2001`,
              values,
            );
            const rows: unknown[][] = [],
              rowKeys: unknown[][] = [];
            let bytes = 0,
              more = page.more;
            const documents = new Map<string, Uint8Array>();
            let documentBytes = 0;
            for (const row of page.rows.slice(0, 2000)) {
              let data: Record<string, SqliteDocumentValue>;
              if (view) {
                const day = table === "neurons" ? "" : row.snapshot_date!,
                  docKey = `${row.netuid}/${day}/${row.shard}`;
                let payload = documents.get(docKey);
                if (!payload) {
                  const document = await scope.first<{
                    payload: Uint8Array | null;
                  }>(
                    `SELECT CASE WHEN octet_length(payload)<=524288 THEN payload END AS payload FROM app.${quote(table + "_documents")} WHERE netuid=$1 AND day=$2 AND shard=$3`,
                    [row.netuid, day, row.shard],
                  );
                  if (
                    !document?.payload ||
                    document.payload.byteLength > 524288
                  )
                    throw new Error("Native export document is unavailable");
                  payload = document.payload;
                  while (documentBytes + payload.byteLength > 8 * 1024 * 1024) {
                    const first = documents.keys().next().value!;
                    documentBytes -= documents.get(first)!.byteLength;
                    documents.delete(first);
                  }
                  documents.set(docKey, payload);
                  documentBytes += payload.byteLength;
                }
                data = Object.fromEntries(
                  identityNames
                    .filter((name) => name !== "shard")
                    .map((name) => [
                      name,
                      row[name] === null
                        ? null
                        : ["netuid", "uid"].includes(name)
                          ? BigInt(row[name]!)
                          : row[name]!,
                    ]),
                );
                const memberKey =
                  table === "account_position_daily"
                    ? "k" +
                      Buffer.from(row.account!).toString("hex").toUpperCase()
                    : row.uid!;
                for (const name of fields!)
                  if (!(name in data))
                    data[name] = decoder.extract(
                      payload,
                      `$."${memberKey}".${name}`,
                    );
              } else {
                data = Object.fromEntries(
                  fields!.map((name) => [
                    name,
                    storedScalar(
                      row[name]!,
                      physical.find((column) => column.name === name)!.type,
                    ),
                  ]),
                );
              }
              const projected = fields!.map((name) =>
                exportValue(data[name]!, lossless, decoder),
              );
              const exactKeys = plan.keys.map((key, index) =>
                integerKey(table, key)
                  ? BigInt(row[`_key${index}`]!)
                  : (row[`_key${index}`] ?? null),
              );
              if (
                lossless &&
                exactKeys.some(
                  (value) =>
                    value === null ||
                    (typeof value === "string"
                      ? value.length > 2048
                      : value < -(1n << 63n) || value >= 1n << 63n),
                )
              )
                throw new Error(
                  "Lossless key cannot resume with the bounded cursor",
                );
              const encodedKeys = lossless
                ? exactKeys.map((value) => exportValue(value, true, decoder))
                : [];
              bytes +=
                Buffer.byteLength(
                  JSON.stringify(
                    lossless ? [projected, encodedKeys] : projected,
                  ),
                ) + 1;
              if (bytes > MAX_BYTES) {
                more = true;
                break;
              }
              rows.push(projected);
              if (lossless) rowKeys.push(encodedKeys);
            }
            more ||= page.rows.length > rows.length;
            if ((page.rows.length || page.more) && !rows.length)
              return fail(413, "export row exceeds byte budget");
            const last = page.rows[rows.length - 1];
            const cursor = more
              ? plan.keys.map((key, index) =>
                  lossless || !integerKey(table, key)
                    ? last![`_key${index}`]
                    : Number(last![`_key${index}`]),
                )
              : null;
            if (
              lossless &&
              cursor !== null &&
              Buffer.byteLength(
                JSON.stringify({ ...input, revision, cursor }),
              ) > 8192
            )
              return fail(
                413,
                "lossless export cursor exceeds request byte budget",
              );
            return reply({
              revision,
              rows,
              next_cursor: cursor,
              ...(lossless ? { row_keys: rowKeys } : {}),
            });
          },
          { isolation: "read committed" },
        );
      } catch {
        return fail(
          503,
          "native export unavailable; no snapshot was acknowledged",
        );
      }
    },
  };
}
