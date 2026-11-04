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
  integerKey?: bigint;
  values: Record<string, SqliteDocumentValue>;
  /** Original SQL TEXT bytes for comparisons before D1 wire replacement. */
  textBytes?: Record<string, Uint8Array>;
}
export type SqliteMetricKeyMode = "text" | "integer";
export interface SqliteMetricTuple {
  key: string;
  integerKey?: bigint;
  json: string | null;
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
  const encode = db.prepare("SELECT jsonb(?1) AS value");
  const textAffinity = db.prepare(
    "SELECT CAST(CAST(?1 AS TEXT) AS BLOB) AS value",
  );
  const numericAffinity = db.prepare("SELECT sum(?1) AS value");
  const integerAffinity = db.prepare("SELECT CAST(?1 AS INTEGER) AS value");
  const matchesInteger = db.prepare("SELECT CAST(?2 AS INTEGER)=?1 AS value");
  const mergeCapture = db.prepare(`SELECT jsonb_patch(?1,CASE
    WHEN (SELECT MIN(json_extract(i.value,'$.captured_at')) FROM json_each(?2) i) > ?3
      THEN ?2
    ELSE (SELECT jsonb_group_object(i.key,json(i.value)) FROM json_each(?2) i
      WHERE json_extract(?1,'$."'||i.key||'".captured_at') IS NULL
        OR json_extract(?1,'$."'||i.key||'".captured_at') < json_extract(i.value,'$.captured_at')) END) AS value
    WHERE (SELECT MIN(json_extract(i.value,'$.captured_at')) FROM json_each(?2) i) > ?3
      OR EXISTS(SELECT 1 FROM json_each(?2) i
        WHERE json_extract(?1,'$."'||i.key||'".captured_at') IS NULL
          OR json_extract(?1,'$."'||i.key||'".captured_at') < json_extract(i.value,'$.captured_at'))`);
  const expiredMembers = db.prepare(
    "SELECT CAST(i.key AS INTEGER) AS uid FROM json_each(?1) i WHERE json_extract(i.value,'$.captured_at') < ?2 ORDER BY i.id",
  );
  const pruneCapture = db.prepare(
    "SELECT jsonb((SELECT jsonb_group_object(i.key,json(i.value)) FROM json_each(?1) i WHERE json_extract(i.value,'$.captured_at') >= ?2)) AS value",
  );
  extract.setReadBigInts(true);
  entries.setReadBigInts(true);
  axons.setReadBigInts(true);
  expiredMembers.setReadBigInts(true);
  numericAffinity.setReadBigInts(true);
  integerAffinity.setReadBigInts(true);
  let closed = false;
  const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const wireText = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
  const scalar = (value: SqliteDocumentValue, storage: unknown) =>
    storage === "text" ? wireText.decode(value as Uint8Array) : value;
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
  const metricInput = (
    payload: Uint8Array,
    names: readonly string[],
    keys: readonly string[] | undefined,
    keyMode: SqliteMetricKeyMode,
  ) => {
    check(payload, "live");
    if (
      names.length > 32 ||
      new Set(names).size !== names.length ||
      names.some((name) => !/^[a-z][a-z0-9_]*$/.test(name)) ||
      !["text", "integer"].includes(keyMode)
    )
      throw new TypeError("Invalid metric document projection");
    const integer = keyMode === "integer";
    const key = integer
      ? "CAST(CAST(key AS TEXT) AS BLOB)"
      : "CAST(key AS BLOB)";
    const identity = integer ? "CAST(key AS INTEGER)" : "key";
    const filter = `WHERE ${integer ? "key IS NOT NULL" : "typeof(key)='text'"}${keys ? ` AND ${identity} IN (SELECT ${integer ? "CAST(value AS INTEGER)" : "value"} FROM json_each(?2))` : ""}`;
    return {
      keyColumns: `${key} AS key${integer ? ",CAST(key AS INTEGER) AS integer_key" : ""}`,
      filter,
      paths: names.map((_, index) => `?${index + (keys ? 3 : 2)}`),
      bindings: [
        payload,
        ...(keys ? [JSON.stringify(keys)] : []),
        ...names.map((name) => `$.${name}`),
      ],
      integer,
    };
  };
  return {
    identity: { ...SQLITE_DOCUMENT_DECODER },
    encode(value: string): Uint8Array {
      if (closed) throw new Error("SQLite document decoder is closed");
      if (typeof value !== "string" || Buffer.byteLength(value) > 2 * 524288)
        throw new RangeError("Document exceeds its explicit encode budget");
      if (valid.get(value, 1)?.valid !== 1)
        throw new TypeError("Malformed JSON document");
      const result = encode.get(value)!.value as Uint8Array;
      check(result, "live");
      return result;
    },
    textAffinity(value: SqliteDocumentValue): string | null {
      if (closed) throw new Error("SQLite document decoder is closed");
      if (
        (typeof value === "string" && Buffer.byteLength(value) > 524288) ||
        (value instanceof Uint8Array && value.byteLength > 524288)
      )
        throw new RangeError("Scalar exceeds its explicit decode budget");
      const result = textAffinity.get(value)!.value;
      return result === null ? null : wireText.decode(result as Uint8Array);
    },
    numericAffinity(value: SqliteDocumentValue): bigint | number | null {
      if (closed) throw new Error("SQLite document decoder is closed");
      if (
        (typeof value === "string" && Buffer.byteLength(value) > 524288) ||
        (value instanceof Uint8Array && value.byteLength > 524288)
      )
        throw new RangeError("Scalar exceeds its explicit decode budget");
      return numericAffinity.get(value)!.value as bigint | number | null;
    },
    integerAffinity(value: SqliteDocumentValue): bigint | null {
      if (closed) throw new Error("SQLite document decoder is closed");
      if (
        (typeof value === "string" && Buffer.byteLength(value) > 524288) ||
        (value instanceof Uint8Array && value.byteLength > 524288)
      )
        throw new RangeError("Scalar exceeds its explicit decode budget");
      return integerAffinity.get(value)!.value as bigint | null;
    },
    matchesInteger(value: SqliteDocumentValue, integer: bigint): boolean {
      if (closed) throw new Error("SQLite document decoder is closed");
      return matchesInteger.get(value, integer)!.value === 1;
    },
    mergeCapture(
      current: Uint8Array,
      incoming: Uint8Array,
      stamp: bigint,
    ): Uint8Array | null {
      check(current, "live");
      check(incoming, "live");
      const row = mergeCapture.get(current, incoming, stamp);
      if (!row) return null;
      const result = row.value as Uint8Array;
      check(result, "live");
      return result;
    },
    pruneCapture(
      payload: Uint8Array,
      cutoff: number,
    ): { payload: Uint8Array; uids: bigint[] } | null {
      check(payload, "live");
      const uids = expiredMembers
        .all(payload, cutoff)
        .map((row) => row.uid as bigint);
      if (!uids.length) return null;
      const result = pruneCapture.get(payload, cutoff)!.value as Uint8Array;
      check(result, "live");
      return { payload: result, uids };
    },
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
      includeTextBytes = false,
      keyMode: SqliteMetricKeyMode = "text",
    ): SqliteMetricEntry[] {
      const input = metricInput(payload, names, keys, keyMode);
      const columns = names.map((_, index) => {
        const field = `json_extract(value,${input.paths[index]})`;
        return `typeof(${field}) AS t${index},CASE WHEN typeof(${field})='text' THEN CAST(${field} AS BLOB) ELSE ${field} END AS v${index}`;
      });
      const statement = db.prepare(
        `SELECT ${input.keyColumns}${columns.length ? `,${columns.join(",")}` : ""} FROM json_each(?1) ${input.filter} ORDER BY id`,
      );
      statement.setReadBigInts(true);
      return statement.all(...input.bindings).map((row) => ({
        key: wireText.decode(row.key as Uint8Array),
        ...(input.integer ? { integerKey: row.integer_key as bigint } : {}),
        values: Object.fromEntries(
          names.map((name, index) => [
            name,
            scalar(row[`v${index}`] as SqliteDocumentValue, row[`t${index}`]),
          ]),
        ),
        ...(includeTextBytes
          ? {
              textBytes: Object.fromEntries(
                names
                  .filter((_, index) => row[`t${index}`] === "text")
                  .map((name) => [
                    name,
                    (row[`v${names.indexOf(name)}`] as Uint8Array).slice(),
                  ]),
              ),
            }
          : {}),
      }));
    },
    memberMetrics(
      payload: Uint8Array,
      names: readonly string[],
      keys: readonly string[],
    ): SqliteMetricEntry[] {
      const input = metricInput(payload, names, keys, "text");
      if (keys.some((key) => !/^-?(0|[1-9][0-9]*)$/.test(key) || key === "-0"))
        throw new TypeError("Invalid canonical member key");
      const columns = names.map((_, index) => {
        const value = `json_extract(?1,'$."'||k.value||'"'||substr(${input.paths[index]},2))`;
        return `typeof(${value}) AS t${index},CASE WHEN typeof(${value})='text' THEN CAST(${value} AS BLOB) ELSE ${value} END AS v${index}`;
      });
      const statement = db.prepare(
        `SELECT CAST(k.value AS BLOB) AS key${columns.length ? `,${columns.join(",")}` : ""} FROM json_each(?2) k ORDER BY k.id`,
      );
      statement.setReadBigInts(true);
      return statement.all(...input.bindings).map((row) => ({
        key: wireText.decode(row.key as Uint8Array),
        values: Object.fromEntries(
          names.map((name, index) => [
            name,
            scalar(row[`v${index}`] as SqliteDocumentValue, row[`t${index}`]),
          ]),
        ),
        textBytes: Object.fromEntries(
          names.flatMap((name, index) =>
            row[`t${index}`] === "text"
              ? [[name, (row[`v${index}`] as Uint8Array).slice()]]
              : [],
          ),
        ),
      }));
    },
    validateMetricEntries(payload: Uint8Array, name: string): void {
      const input = metricInput(payload, [name], undefined, "integer");
      // A source WHERE predicate can run before the membership lookup. Keep
      // malformed orphan values observable even though no row is returned.
      const statement = db.prepare(
        "SELECT json_extract(value,?2) FROM json_each(?1)",
      );
      statement.setReadBigInts(true);
      statement.all(...input.bindings);
    },
    metricTuples(
      payload: Uint8Array,
      names: readonly string[],
      keys?: readonly string[],
      keyMode: SqliteMetricKeyMode = "text",
    ): SqliteMetricTuple[] {
      const input = metricInput(payload, names, keys, keyMode);
      if (names.length < 2)
        throw new TypeError("Metric tuples require multiple fields");
      const statement = db.prepare(
        `SELECT ${input.keyColumns},CAST(json_extract(value,${input.paths.join(",")}) AS BLOB) AS tuple FROM json_each(?1) ${input.filter} ORDER BY id`,
      );
      statement.setReadBigInts(true);
      return statement.all(...input.bindings).map((row) => ({
        key: wireText.decode(row.key as Uint8Array),
        ...(input.integer ? { integerKey: row.integer_key as bigint } : {}),
        json:
          row.tuple === null ? null : wireText.decode(row.tuple as Uint8Array),
      }));
    },
    axons(payload: Uint8Array): { key: string; value: SqliteDocumentValue }[] {
      check(payload, "live");
      return axons.all(payload).map((row) => ({
        key: wireText.decode(row.key as Uint8Array),
        value: scalar(row.value as SqliteDocumentValue, row.storage),
      }));
    },
    close() {
      if (!closed) db.close();
      closed = true;
    },
  };
}
