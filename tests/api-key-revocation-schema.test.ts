import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { test } from "vitest";

test("revocation intent migration preserves existing keys and survives reapplication", async () => {
  const db = new PGlite();
  try {
    const existing = readFileSync(
      "migrations/neon/0005_remaining_d1_tables.sql",
      "utf8",
    );
    await db.exec(
      existing.slice(
        existing.indexOf("CREATE TABLE IF NOT EXISTS rpc_accounts"),
        existing.indexOf("-- The partial unique index is the constraint"),
      ),
    );
    await db.exec(
      "INSERT INTO api_keys (unkey_key_id,owner_contact,tier,created_at,revoked_at) VALUES ('key_active','synthetic','free',1,NULL),('key_revoked','synthetic','free',2,3)",
    );
    const migration = readFileSync(
      "migrations/neon/0038_api_key_revocation_intent.sql",
      "utf8",
    );
    await db.exec(migration);
    assert.deepEqual(
      (
        await db.query(
          "SELECT unkey_key_id,revoked_at,revocation_requested_at FROM api_keys ORDER BY unkey_key_id",
        )
      ).rows,
      [
        {
          unkey_key_id: "key_active",
          revoked_at: null,
          revocation_requested_at: null,
        },
        {
          unkey_key_id: "key_revoked",
          revoked_at: 3,
          revocation_requested_at: null,
        },
      ],
    );
    await db.exec(
      "UPDATE api_keys SET revocation_requested_at=4 WHERE unkey_key_id='key_active'",
    );
    await db.exec(migration);
    assert.equal(
      (
        await db.query<{ revocation_requested_at: number }>(
          "SELECT revocation_requested_at FROM api_keys WHERE unkey_key_id='key_active'",
        )
      ).rows[0]!.revocation_requested_at,
      4,
    );
    await assert.rejects(
      db.exec(
        "INSERT INTO api_keys (unkey_key_id,owner_contact,tier,created_at) VALUES ('key_active','synthetic','free',5)",
      ),
      /duplicate key/,
    );
  } finally {
    await db.close();
  }
});
