// Real-role qualification of the capability split (infra#882): a PostgreSQL
// role granted exactly a serving process's declared writes passes startup
// verification, and everything outside the declaration fails closed with the
// relation named -- proven against actual grants, not mocks.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, describe, it } from "node:test";
import { Client, Pool } from "pg";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";
import { createPgStoreRuntime } from "../src/pg-store-runtime.ts";
import {
  verifyNativeSourceCapabilities,
  type NativeSourceDefinition,
} from "../src/native-api-process.ts";

const url = pg18FixtureUrl();
const suffix = randomUUID().replaceAll("-", "");
const schema = "capability_split_" + suffix;
const role = "capability_role_" + suffix;
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
const definition = (
  overrides: Partial<NativeSourceDefinition> = {},
): NativeSourceDefinition => ({
  name: "fixture",
  schema,
  owner: url.username,
  relations: ["user_state", "history"],
  access: "read-write",
  writable: ["user_state"],
  ...overrides,
});

describe(
  "capability-split startup verification",
  { concurrency: false },
  () => {
    before(async () => {
      await control.connect();
      await control.query(`CREATE SCHEMA ${schema}`);
      created = true;
      await control.query(`CREATE ROLE ${role} LOGIN PASSWORD 'fixture-only'`);
      await control.query(
        `CREATE TABLE ${schema}.user_state(id bigserial PRIMARY KEY, value text)`,
      );
      await control.query(
        `CREATE TABLE ${schema}.history(id bigint PRIMARY KEY, value text)`,
      );
      // Exactly the serving grant: read everything, write only user_state.
      await control.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
      await control.query(
        `GRANT SELECT ON ${schema}.user_state, ${schema}.history TO ${role}`,
      );
      await control.query(
        `GRANT INSERT,UPDATE,DELETE ON ${schema}.user_state TO ${role}`,
      );
      await control.query(
        `GRANT USAGE ON SEQUENCE ${schema}.user_state_id_seq TO ${role}`,
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

    it("the narrow role passes verification for exactly its declared writes", async () => {
      await verifyNativeSourceCapabilities(runtime, [definition()]);
    });

    it("declaring a write the role does not hold fails closed, naming the relation", async () => {
      await assert.rejects(
        verifyNativeSourceCapabilities(runtime, [
          definition({ writable: ["user_state", "history"] }),
        ]),
        /not ready for history/,
      );
    });

    it("a write set outside the declared relations is refused before any query", async () => {
      for (const writable of [["user_state", "undeclared"], [] as string[]])
        await assert.rejects(
          verifyNativeSourceCapabilities(runtime, [definition({ writable })]),
          /writes outside its capability/,
        );
      await assert.rejects(
        verifyNativeSourceCapabilities(runtime, [
          definition({ access: "read", writable: ["user_state"] }),
        ]),
        /writes outside its capability/,
      );
    });

    it("the same role cannot mutate history, perform DDL, or assume a broader role", async () => {
      await runtime.transaction(async (tx) => {
        await tx.run(`INSERT INTO ${schema}.user_state(value) VALUES ('ok')`);
      });
      for (const denied of [
        `INSERT INTO ${schema}.history(id, value) VALUES (1, 'no')`,
        `UPDATE ${schema}.history SET value='no'`,
        `DELETE FROM ${schema}.history`,
        `CREATE TABLE ${schema}.escalation(id int)`,
        `SET ROLE ${url.username}`,
      ])
        await assert.rejects(
          runtime.transaction(async (tx) => {
            await tx.run(denied);
          }),
          /permission denied|must be a member/i,
        );
      // The declared read still works where the write was denied.
      const rows = await runtime.transaction(async (tx) =>
        tx.query<{ n: string }>(`SELECT count(*) AS n FROM ${schema}.history`),
      );
      assert.equal(Number(rows[0]!.n), 0);
    });
  },
);
