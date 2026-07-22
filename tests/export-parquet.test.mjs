import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { attachPostgres, libpqConnString } from "../scripts/export-parquet.ts";

const BASE = { host: "h", port: 5432, dbname: "d", user: "u" };

describe("export-parquet libpqConnString", () => {
  test("escapes a single quote in a field value (would otherwise break out of its field)", () => {
    assert.equal(
      libpqConnString({ ...BASE, password: "pa'ss" }),
      "host=h port=5432 dbname=d user=u password=pa\\'ss",
    );
  });

  test("escapes a backslash", () => {
    assert.equal(
      libpqConnString({ ...BASE, password: "pa\\ss" }),
      "host=h port=5432 dbname=d user=u password=pa\\\\ss",
    );
  });

  test("escapes both a backslash and a single quote in one value", () => {
    assert.equal(
      libpqConnString({ ...BASE, password: "a\\b'c" }),
      "host=h port=5432 dbname=d user=u password=a\\\\b\\'c",
    );
  });

  test("leaves a value containing neither untouched", () => {
    assert.equal(
      libpqConnString({
        host: "db.internal",
        port: 5432,
        dbname: "reg",
        user: "ro",
        password: "plain123",
      }),
      "host=db.internal port=5432 dbname=reg user=ro password=plain123",
    );
  });
});

describe("export-parquet attachPostgres", () => {
  const conn = {
    host: "db.internal",
    port: 5432,
    dbname: "reg",
    user: "ro",
    password: "s3cr3t-PLAINTEXT",
  };

  test("re-throws a scrubbed error that never contains the plaintext password on ATTACH failure", async () => {
    const connection = {
      // DuckDB's own ATTACH failure embeds the whole connection string, password
      // included -- the exact leak this function's comment says it prevents.
      run: async () => {
        throw new Error(
          `IO Error: could not connect: host=db.internal password=${conn.password} port=5432`,
        );
      },
    };
    await assert.rejects(
      attachPostgres(connection, "registry", conn),
      (err) => {
        assert.ok(
          !err.message.includes(conn.password),
          "re-thrown error leaked the plaintext password",
        );
        assert.match(err.message, /credentials redacted/);
        assert.match(
          err.message,
          /failed to attach registry Postgres at db\.internal:5432\/reg/,
        );
        return true;
      },
    );
  });

  test("passes an ATTACH statement built from libpqConnString to connection.run on success", async () => {
    let ran;
    const connection = {
      run: async (statement) => {
        ran = statement;
      },
    };
    await attachPostgres(connection, "indexer", conn);
    assert.match(ran, /^ATTACH '.*' AS indexer \(TYPE postgres, READ_ONLY\)$/);
    assert.ok(ran.includes(libpqConnString(conn)));
  });
});
