// Regression test for a real bug (found by Superagent's security scan on
// #5027): enqueue_chain_firehose() (deploy/postgres/schema.sql) branches on
// TG_ARGV[0] per logical table, and INSERTs that same value into
// chain_firehose_outbox.table_name -- but the table's own CHECK constraint
// listed only three of the four values the function actually handles
// ('account_events' was added to the function's branches by #5011 without
// updating the constraint). Every account_events insert through that
// trigger would have violated the CHECK, rolling back the whole writer
// transaction -- a guaranteed 100%-failure version of the exact commit-time
// failure #5027 was written to eliminate.
//
// deploy/postgres/schema.sql has no live-Postgres test harness (DDL is
// applied by a deploy script, not exercised by vitest), so this reads it as
// text and cross-checks the two lists directly, in both directions: a
// branch with no matching constraint value would 100%-fail every insert for
// that table (this bug); a constraint value with no matching branch is a
// silent no-op (rows never enqueued, never a hard failure, but the same
// class of drift).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { repoRoot } from "../scripts/lib.ts";

test("chain_firehose_outbox's table_name CHECK constraint matches every enqueue_chain_firehose() TG_ARGV branch", async () => {
  const schema = await readFile(
    path.join(repoRoot, "deploy/postgres/schema.sql"),
    "utf8",
  );

  const constraintMatch = schema.match(
    /table_name\s+TEXT NOT NULL CHECK \(table_name IN \(([^)]+)\)\)/,
  );
  assert.ok(
    constraintMatch,
    "chain_firehose_outbox's CHECK constraint not found",
  );
  const constraintValues = [...constraintMatch[1].matchAll(/'([a-z_]+)'/g)].map(
    (m) => m[1],
  );

  const functionMatch = schema.match(
    /CREATE (?:OR REPLACE )?FUNCTION enqueue_chain_firehose\(\)[\s\S]*?\$\$ LANGUAGE plpgsql;/,
  );
  assert.ok(functionMatch, "enqueue_chain_firehose() body not found");
  const branchValues = [
    ...functionMatch[0].matchAll(/TG_ARGV\[0\] = '([a-z_]+)'/g),
  ].map((m) => m[1]);

  assert.ok(branchValues.length > 0, "found no TG_ARGV branches to compare");
  assert.deepEqual(
    [...constraintValues].sort(),
    [...branchValues].sort(),
    "chain_firehose_outbox's CHECK constraint and enqueue_chain_firehose()'s TG_ARGV branches have drifted apart",
  );
});

test("enqueue_chain_firehose() bounds the pending outbox backlog before inserting", async () => {
  const schema = await readFile(
    path.join(repoRoot, "deploy/postgres/schema.sql"),
    "utf8",
  );
  const functionMatch = schema.match(
    /CREATE (?:OR REPLACE )?FUNCTION enqueue_chain_firehose\(\)[\s\S]*?\$\$ LANGUAGE plpgsql;/,
  );
  assert.ok(functionMatch, "enqueue_chain_firehose() body not found");
  const functionBody = functionMatch[0];

  assert.match(
    functionBody,
    /DELETE FROM chain_firehose_outbox\s+WHERE delivered_at IS NULL\s+AND created_at < now\(\) - INTERVAL '1 hour'/,
    "enqueue_chain_firehose() must prune stale pending rows so relay downtime cannot retain them indefinitely",
  );
  assert.match(
    functionBody,
    /ORDER BY id DESC\s+OFFSET 4999\s+FOR UPDATE SKIP LOCKED/,
    "enqueue_chain_firehose() must drop oldest pending overflow while preserving room for the new row",
  );
  assert.match(
    functionBody,
    /INSERT INTO chain_firehose_outbox \(table_name, payload\)/,
    "enqueue_chain_firehose() must still append the current payload after pruning",
  );
  assert.ok(
    functionBody.indexOf("OFFSET 4999") <
      functionBody.indexOf("INSERT INTO chain_firehose_outbox"),
    "pending backlog pruning must happen before inserting the next row",
  );
});
