// Derive a column census from the committed physical D1 snapshot. This never
// connects to D1, reads rows, or replaces the retained logical view contract.
import type { BundleSourceColumn } from "./archive-policy-bundles.ts";
import type { SchemaObject } from "./snapshot-d1-schema.ts";

const NAME = /^[a-z][a-z0-9_]{0,127}$/;
const statementText = (sql: string): string =>
  sql.trim().replace(/;$/, "").trimEnd();

export async function d1BundleSourceColumns(
  snapshot: readonly SchemaObject[],
  selectedTables: readonly string[],
): Promise<BundleSourceColumn[]> {
  // Empty production mappings must not initialize a database or select tables.
  if (!selectedTables.length) return [];
  const tables = [...new Set(selectedTables)].sort();
  const definitions = tables.map((table) => {
    if (!NAME.test(table)) throw new Error(`invalid D1 source name: ${table}`);
    const matches = snapshot.filter((item) => item.name === table);
    const object = matches[0];
    if (
      matches.length !== 1 ||
      !object ||
      object.type !== "table" ||
      object.tbl_name !== table
    )
      throw new Error(`D1 source needs one physical table: ${table}`);
    // Only a named ordinary CREATE TABLE is prepared. Views, virtual tables,
    // triggers and unrelated snapshot objects are never executed.
    if (
      !new RegExp(
        `^CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:${table}|"${table}")\\s*\\(`,
        "i",
      ).test(object.sql.trim())
    )
      throw new Error(`unsupported D1 table definition: ${table}`);
    return { table, sql: object.sql };
  });
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(":memory:");
  try {
    for (const { table, sql } of definitions) {
      const statement = database.prepare(sql);
      // sqlite3_sql exposes the one prepared statement. Reject a tail instead
      // of passing a multi-statement string to exec(). No row SQL is run.
      if (statementText(statement.sourceSQL) !== statementText(sql))
        throw new Error(`D1 table definition has trailing SQL: ${table}`);
      statement.run();
    }
    const columns: BundleSourceColumn[] = [];
    const inspect = database.prepare(
      'SELECT name,type,"notnull",hidden FROM pragma_table_xinfo(?) ORDER BY cid',
    );
    for (const table of tables) {
      const rows = inspect.all(table);
      if (!rows.length) throw new Error(`D1 table has no columns: ${table}`);
      for (const row of rows) {
        if (
          typeof row.name !== "string" ||
          !NAME.test(row.name) ||
          typeof row.type !== "string" ||
          !row.type ||
          (row.notnull !== 0 && row.notnull !== 1) ||
          (row.hidden !== 0 && row.hidden !== 2 && row.hidden !== 3)
        )
          throw new Error(`unsupported D1 source column: ${table}`);
        columns.push({
          table,
          column: row.name,
          udt: row.type,
          nullable: row.notnull === 0,
        });
      }
    }
    return columns;
  } finally {
    database.close();
  }
}
