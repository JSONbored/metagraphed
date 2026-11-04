import { DatabaseSync } from "node:sqlite";

export const SQLITE_DOCUMENT_DECODER = Object.freeze({
  version: "3.53.4",
  sourceId:
    "2026-07-24 19:02:57 bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc",
} as const);

export type SqliteDocumentValue = null | bigint | number | string | Uint8Array;
export type SqliteStoredValue =
  ["integer" | "real" | "text" | "blob", string] | null;

/** A JSON-safe, reversible representation of a SQLite scalar. Text uses JSON
 * quoting, so embedded NUL never becomes a PostgreSQL text character. */
export function storeSqliteValue(
  value: SqliteDocumentValue,
): SqliteStoredValue {
  if (value === null) return null;
  if (typeof value === "bigint") {
    if (value < -(1n << 63n) || value >= 1n << 63n)
      throw new TypeError("SQLite integer is out of range");
    return ["integer", value.toString()];
  }
  if (typeof value === "number") {
    if (Number.isNaN(value)) throw new TypeError("SQLite cannot store NaN");
    const bytes = Buffer.allocUnsafe(8);
    bytes.writeDoubleBE(value);
    return ["real", bytes.toString("hex")];
  }
  if (typeof value === "string") return ["text", JSON.stringify(value)];
  return ["blob", Buffer.from(value).toString("hex")];
}

export function readSqliteValue(value: unknown): SqliteDocumentValue {
  if (value === null) return null;
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[1] !== "string" ||
    !["integer", "real", "text", "blob"].includes(value[0])
  )
    throw new TypeError("Invalid SQLite scalar tag");
  const [type, text] = value;
  if (type === "integer") {
    if (!/^-?(0|[1-9][0-9]*)$/.test(text) || text === "-0")
      throw new TypeError("Invalid SQLite integer");
    const integer = BigInt(text);
    if (integer < -(1n << 63n) || integer >= 1n << 63n)
      throw new TypeError("SQLite integer is out of range");
    return integer;
  }
  if (type === "text") {
    const decoded: unknown = JSON.parse(text);
    if (typeof decoded !== "string") throw new TypeError("Invalid SQLite text");
    return decoded;
  }
  if (!/^(?:[a-f0-9]{2})*$/.test(text))
    throw new TypeError("Invalid SQLite binary value");
  const bytes = Buffer.from(text, "hex");
  if (type === "blob") return bytes;
  if (type !== "real" || bytes.length !== 8)
    throw new TypeError("Invalid SQLite real");
  const number = bytes.readDoubleBE();
  if (Number.isNaN(number)) throw new TypeError("SQLite cannot store NaN");
  return number;
}

export interface SqliteDocumentEntry {
  key: string | bigint;
  type: string;
  value: SqliteDocumentValue;
  atom: SqliteDocumentValue;
}

export interface SqliteMetricEntry {
  key: string;
  values: Record<string, SqliteDocumentValue>;
}

/** SQLite is used only as the decoder for its binary JSON format. This readonly
 * in-memory connection has no schema, persistent file, extensions or caller SQL.
 * PostgreSQL owns all persistent application data. */
export function createSqliteDocumentDecoder(options: {
  maxAuditBytes: number;
}) {
  if (
    !Number.isSafeInteger(options.maxAuditBytes) ||
    options.maxAuditBytes <= 0
  )
    throw new TypeError("An explicit positive audit decode budget is required");
  const db = new DatabaseSync(":memory:", {
    readOnly: true,
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
  });
  const identity = db
    .prepare(
      "SELECT sqlite_version() AS version,sqlite_source_id() AS sourceId",
    )
    .get();
  if (
    identity?.version !== SQLITE_DOCUMENT_DECODER.version ||
    identity.sourceId !== SQLITE_DOCUMENT_DECODER.sourceId
  ) {
    db.close();
    throw new Error(
      `Unsupported SQLite document decoder identity: ${JSON.stringify(identity)}`,
    );
  }
  db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF");
  const valid = db.prepare("SELECT json_valid(?1,?2) AS valid");
  const text = db.prepare("SELECT CAST(json(?1) AS BLOB) AS value");
  // Node's SQLite TEXT boundary truncates embedded NUL. Fetch those values as
  // bytes and decode explicitly so the SQL value survives that boundary.
  const extract = db.prepare(
    "SELECT typeof(value) AS storage,CASE WHEN typeof(value)='text' THEN CAST(value AS BLOB) ELSE value END AS value FROM (SELECT json_extract(?1,?2) AS value)",
  );
  const entries = db.prepare(
    "SELECT typeof(key) AS key_storage,CASE WHEN typeof(key)='text' THEN CAST(key AS BLOB) ELSE key END AS key,type,typeof(value) AS value_storage,CASE WHEN typeof(value)='text' THEN CAST(value AS BLOB) ELSE value END AS value,typeof(atom) AS atom_storage,CASE WHEN typeof(atom)='text' THEN CAST(atom AS BLOB) ELSE atom END AS atom FROM json_each(?1,?2) ORDER BY id",
  );
  const axons = db.prepare(
    "WITH payload AS MATERIALIZED (SELECT key,CASE WHEN type='object' THEN json_extract(value,'$.axon') END AS axon,MIN(id) AS first_id FROM json_each(?1) WHERE typeof(key)='text' GROUP BY key) SELECT CAST(key AS BLOB) AS key,typeof(axon) AS storage,CASE WHEN typeof(axon)='text' THEN CAST(axon AS BLOB) ELSE axon END AS value FROM payload ORDER BY first_id",
  );
  extract.setReadBigInts(true);
  entries.setReadBigInts(true);
  axons.setReadBigInts(true);
  let closed = false;
  const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const scalar = (value: SqliteDocumentValue, storage: unknown) =>
    storage === "text" ? utf8.decode(value as Uint8Array) : value;
  const check = (payload: Uint8Array, kind: "live" | "audit") => {
    if (closed) throw new Error("SQLite document decoder is closed");
    const max = kind === "live" ? 524288 : options.maxAuditBytes;
    if (payload.byteLength > max)
      throw new RangeError("Document exceeds its explicit decode budget");
    // Live documents require strict JSONB; historical audit blobs have no such
    // source constraint and json_extract also accepts JSON text and JSON5.
    if (valid.get(payload, kind === "live" ? 8 : 11)?.valid !== 1)
      throw new TypeError("Malformed SQLite document");
  };
  return {
    identity: { ...SQLITE_DOCUMENT_DECODER },
    decode(payload: Uint8Array, kind: "live" | "audit" = "live"): string {
      check(payload, kind);
      return utf8.decode(text.get(payload)!.value as Uint8Array);
    },
    extract(
      payload: Uint8Array,
      path: string,
      kind: "live" | "audit" = "live",
    ): SqliteDocumentValue {
      check(payload, kind);
      const row = extract.get(payload, path)!;
      return scalar(row.value as SqliteDocumentValue, row.storage);
    },
    entries(
      payload: Uint8Array,
      path = "$",
      kind: "live" | "audit" = "live",
    ): SqliteDocumentEntry[] {
      check(payload, kind);
      return entries.all(payload, path).map((row) => ({
        key: scalar(row.key as SqliteDocumentValue, row.key_storage) as
          string | bigint,
        type: row.type as string,
        value: scalar(row.value as SqliteDocumentValue, row.value_storage),
        atom: scalar(row.atom as SqliteDocumentValue, row.atom_storage),
      }));
    },
    metricEntries(
      payload: Uint8Array,
      names: readonly string[],
      keys?: readonly string[],
    ): SqliteMetricEntry[] {
      check(payload, "live");
      if (
        names.length > 32 ||
        new Set(names).size !== names.length ||
        names.some((name) => !/^[a-z][a-z0-9_]*$/.test(name))
      )
        throw new TypeError("Invalid metric document projection");
      const columns = names.map((_, index) => {
        const field = `json_extract(value,?${index + (keys ? 3 : 2)})`;
        return `typeof(${field}) AS t${index},CASE WHEN typeof(${field})='text' THEN CAST(${field} AS BLOB) ELSE ${field} END AS v${index}`;
      });
      const statement = db.prepare(
        `SELECT CAST(key AS BLOB) AS key${columns.length ? `,${columns.join(",")}` : ""} FROM json_each(?1) WHERE typeof(key)='text'${keys ? " AND key IN (SELECT value FROM json_each(?2))" : ""} ORDER BY id`,
      );
      statement.setReadBigInts(true);
      return statement
        .all(
          payload,
          ...(keys ? [JSON.stringify(keys)] : []),
          ...names.map((name) => `$.${name}`),
        )
        .map((row) => ({
          key: utf8.decode(row.key as Uint8Array),
          values: Object.fromEntries(
            names.map((name, index) => [
              name,
              scalar(row[`v${index}`] as SqliteDocumentValue, row[`t${index}`]),
            ]),
          ),
        }));
    },
    axons(payload: Uint8Array): { key: string; value: SqliteDocumentValue }[] {
      check(payload, "live");
      return axons.all(payload).map((row) => ({
        key: utf8.decode(row.key as Uint8Array),
        value: scalar(row.value as SqliteDocumentValue, row.storage),
      }));
    },
    close() {
      if (!closed) db.close();
      closed = true;
    },
  };
}
