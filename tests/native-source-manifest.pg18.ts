import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, describe, it } from "node:test";
import { Client, Pool } from "pg";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";
import { createPgStoreRuntime } from "../src/pg-store-runtime.ts";
import {
  nativeSourceDefinitions,
  assertNativeSequencePrivileges,
} from "../src/native-source-manifest.ts";
import type { NativeSource } from "../src/native-api-process.ts";

const url = pg18FixtureUrl();
const suffix = randomUUID().replaceAll("-", "");
const schema = "native_source_" + suffix;
const role = "native_source_role_" + suffix;
const control = new Client({
  connectionString: url.toString(),
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000,
});
const restricted = new URL(url);
restricted.username = role;
const runtime = createPgStoreRuntime(
  {
    connectionString: restricted.toString(),
    maxConnections: 1,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 1000,
    statementTimeoutMillis: 5000,
    onIdleError() {},
  },
  (config) => new Pool(config),
);
let created = false;
const owners = {
  app: url.username,
  auth: url.username,
  jobs: url.username,
  realtime: url.username,
  retained: url.username,
  search: url.username,
};
const sources = new Map<string, NativeSource>(
  nativeSourceDefinitions(owners).map((definition) => [
    definition.name,
    { ...runtime, ...definition, schema, relations: ["items"] },
  ]),
);

describe("native generated ID readiness", { concurrency: false }, () => {
  before(async () => {
    await control.connect();
    assert.equal(
      (await control.query("SHOW server_version_num")).rows[0]
        .server_version_num,
      "180006",
    );
    await control.query(`CREATE SCHEMA ${schema}`);
    created = true;
    await control.query(`CREATE ROLE ${role} LOGIN PASSWORD 'fixture-only'`);
    await control.query(
      `CREATE TABLE ${schema}.items(id bigserial PRIMARY KEY,value text)`,
    );
    await control.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await control.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON ${schema}.items TO ${role}`,
    );
  });
  after(async () => {
    await runtime.close();
    try {
      if (created) {
        await control.query(`DROP SCHEMA ${schema} CASCADE`);
        await control.query(`DROP ROLE IF EXISTS ${role}`);
      }
    } finally {
      await control.end();
    }
  });
  it("refuses table-only grants without consuming the sequence", async () => {
    await assert.rejects(
      assertNativeSequencePrivileges(sources),
      /sequence privilege is unavailable/,
    );
    const state = (
      await control.query(
        `SELECT last_value::int,is_called FROM ${schema}.items_id_seq`,
      )
    ).rows[0];
    assert.deepEqual(state, { last_value: 1, is_called: false });
  });
  it("accepts UPDATE or USAGE sequence permission without allocating an ID", async () => {
    await control.query(
      `GRANT UPDATE ON SEQUENCE ${schema}.items_id_seq TO ${role}`,
    );
    await assertNativeSequencePrivileges(sources);
    await control.query(
      `REVOKE UPDATE ON SEQUENCE ${schema}.items_id_seq FROM ${role}`,
    );
    await control.query(
      `GRANT USAGE ON SEQUENCE ${schema}.items_id_seq TO ${role}`,
    );
    await assertNativeSequencePrivileges(sources);
    assert.deepEqual(
      (
        await control.query(
          `SELECT last_value::int,is_called FROM ${schema}.items_id_seq`,
        )
      ).rows[0],
      { last_value: 1, is_called: false },
    );
  });
});
