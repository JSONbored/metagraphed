// The identity-plane handoff migration (infra#820): the 0010 staging twins
// retire so the producer tree's identity plane composes without collision.
// What this pins: the drop is complete, the occupied-guard REFUSES rather than
// deletes (a row in a staging twin means the apply order was violated and
// import data would be lost), and serving-owned operational state survives.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, test } from "vitest";

const migration = (name: string) =>
  readFileSync(new URL(`../migrations/postgres/${name}`, import.meta.url), {
    encoding: "utf8",
  });

let db: PGlite;
afterEach(() => db.close());

async function applyThrough0033(database: PGlite) {
  await database.exec(migration("0010_account_state.sql"));
  await database.exec(migration("0033_account_numeric.sql"));
}

test("the handoff retires exactly the three staging twins and keeps operational state", async () => {
  db = new PGlite();
  await applyThrough0033(db);
  await db.exec(migration("0056_identity_plane_handoff.sql"));
  const remaining = await db.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='app' ORDER BY tablename",
  );
  const names = remaining.rows.map((row) => row.tablename);
  for (const twin of ["rpc_accounts", "github_accounts", "api_keys"])
    assert.ok(!names.includes(twin), `${twin} must retire`);
  for (const kept of [
    "api_key_blocks",
    "api_key_usage_daily",
    "api_quota_daily",
    "api_usage_rollup",
    "api_usage_rollup_batches",
  ])
    assert.ok(names.includes(kept), `${kept} is serving-owned and stays`);
});

test("a staging twin holding rows refuses the handoff instead of deleting them", async () => {
  db = new PGlite();
  await applyThrough0033(db);
  await db.exec(
    "INSERT INTO app.rpc_accounts(ss58, created_at) VALUES ('fixture', 0)",
  );
  await assert.rejects(
    db.exec(migration("0056_identity_plane_handoff.sql")),
    /holds rows.*infra#820 mapping/,
  );
  // The refusal protected the row and dropped nothing.
  const kept = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM app.rpc_accounts",
  );
  assert.equal(kept.rows[0]!.n, 1);
});

test("re-applying over an already-composed schema is a no-op, not a failure", async () => {
  db = new PGlite();
  await applyThrough0033(db);
  await db.exec(migration("0056_identity_plane_handoff.sql"));
  await db.exec(migration("0056_identity_plane_handoff.sql"));
});
