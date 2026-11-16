// The identity-plane handoff migration (infra#820): the colliding api_keys
// staging twin retires so the producer tree's identity plane composes without
// collision. What this pins: the drop is exactly the collision (rpc_accounts
// and github_accounts stay -- the native OAuth tier lookup and login upserts
// still consume them until the step-3 re-point), the occupied-guard REFUSES
// rather than deletes (a row in the staging twin means the apply order was
// violated and import data would be lost), and serving-owned operational
// state survives.
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

test("the handoff retires exactly the colliding twin and keeps the live-consumed shapes", async () => {
  db = new PGlite();
  await applyThrough0033(db);
  await db.exec(migration("0056_identity_plane_handoff.sql"));
  const remaining = await db.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='app' ORDER BY tablename",
  );
  const names = remaining.rows.map((row) => row.tablename);
  assert.ok(!names.includes("api_keys"), "the colliding twin must retire");
  for (const kept of [
    // Still consumed by the native serving path (OAuth tier lookup, login
    // upserts) -- they retire with the infra#820 step-3 re-point, never here.
    "rpc_accounts",
    "github_accounts",
    // Serving-owned operational state.
    "api_key_blocks",
    "api_key_usage_daily",
    "api_quota_daily",
    "api_usage_rollup",
    "api_usage_rollup_batches",
  ])
    assert.ok(names.includes(kept), `${kept} stays`);
});

test("a staging twin holding rows refuses the handoff instead of deleting them", async () => {
  db = new PGlite();
  await applyThrough0033(db);
  await db.exec(
    "INSERT INTO app.api_keys(owner_contact, created_at) VALUES ('fixture', 0)",
  );
  await assert.rejects(
    db.exec(migration("0056_identity_plane_handoff.sql")),
    /holds rows.*infra#820 mapping/,
  );
  // The refusal protected the row and dropped nothing.
  const kept = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM app.api_keys",
  );
  assert.equal(kept.rows[0]!.n, 1);
});

test("re-applying over an already-composed schema is a no-op, not a failure", async () => {
  db = new PGlite();
  await applyThrough0033(db);
  await db.exec(migration("0056_identity_plane_handoff.sql"));
  await db.exec(migration("0056_identity_plane_handoff.sql"));
});

test("a producer-shaped api_keys under the same name is never dropped, even empty", async () => {
  // Engine review on the handoff: the name alone does not identify the twin.
  // On an out-of-order or replayed apply the producer's own app.api_keys
  // (uuid/token_digest) can already stand here; the drop must fire only on
  // the staging shape.
  db = new PGlite();
  await applyThrough0033(db);
  await db.exec("DROP TABLE app.api_keys");
  await db.exec(
    `CREATE TABLE app.api_keys (
       key_id uuid PRIMARY KEY,
       account_id uuid NOT NULL,
       token_digest text NOT NULL UNIQUE,
       expires_at timestamptz NOT NULL
     )`,
  );
  await db.exec(migration("0056_identity_plane_handoff.sql"));
  const survived = await db.query<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='app' AND table_name='api_keys' AND column_name='token_digest'",
  );
  assert.equal(survived.rows.length, 1, "the producer shape must survive");
});
