import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { test } from "vitest";
import {
  listCandidates,
  promoteReading,
} from "../scripts/review-treasury-readings.ts";
import type { D1AdminStatement } from "../scripts/lib/d1-admin.ts";

test("manual D1 treasury review lists every candidate and atomically publishes only the named reading", async () => {
  const runtime = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('test')}}",
    compatibilityDate: "2026-06-06",
    d1Databases: ["DB"],
  });
  try {
    const db = await runtime.getD1Database("DB");
    for (const name of [
      "0011_economic_reference_state.sql",
      "0016_archive_export_revisions.sql",
    ])
      for (const sql of readFileSync(
        new URL(`../migrations/d1/${name}`, import.meta.url),
        "utf8",
      ).split("-- statement-breakpoint"))
        if (sql.trim()) await db.prepare(sql).run();
    const batch = async (statements: readonly D1AdminStatement[]) =>
      db.batch<Record<string, unknown>>(
        statements.map((s) =>
          s.params?.length
            ? db.prepare(s.sql).bind(...s.params)
            : db.prepare(s.sql),
        ),
      );
    assert.deepEqual(await listCandidates(batch), []);
    await db
      .prepare(
        "INSERT INTO treasury_readings(netuid,source_url,read_at_sha,observed_at,first_seen,found) SELECT 7,'https://example.com/'||printf('%03d',value),'sha',1790000000000,1790000000000,0 FROM json_each(?)",
      )
      .bind(JSON.stringify(Array.from({ length: 503 }, (_, i) => i)))
      .run();
    const candidates = await listCandidates(batch);
    assert.equal(candidates.length, 503);
    assert.equal(candidates[0]?.found, false);
    assert.equal(candidates.at(-1)?.source_url, "https://example.com/502");
    const command = {
      action: "promote" as const,
      netuid: 7,
      sourceUrl: "https://example.com/001",
      state: "reviewed" as const,
    };
    assert.deepEqual(await promoteReading(command, 1790000000010, batch), [
      { netuid: 7, source_url: command.sourceUrl, review_state: "reviewed" },
    ]);
    assert.equal(
      await db
        .prepare("SELECT reviewed_at FROM treasury_readings WHERE source_url=?")
        .bind(command.sourceUrl)
        .first("reviewed_at"),
      1790000000010,
    );
    assert.equal(
      await db
        .prepare("SELECT revision FROM archive_export_revisions")
        .first("revision"),
      1,
    );
    assert.equal((await listCandidates(batch)).length, 502);
    assert.deepEqual(
      await promoteReading(
        { ...command, sourceUrl: "https://example.com/absent" },
        1790000000011,
        batch,
      ),
      [],
    );
    assert.equal(
      await db
        .prepare("SELECT revision FROM archive_export_revisions")
        .first("revision"),
      1,
    );
    // A failed revision statement rolls the preceding UPDATE back too.
    await db
      .prepare(
        "CREATE TRIGGER reject_revision BEFORE UPDATE ON archive_export_revisions BEGIN SELECT RAISE(ABORT,'test revision failure'); END",
      )
      .run();
    await assert.rejects(
      promoteReading({ ...command, state: "rejected" }, 1790000000020, batch),
      /test revision failure/,
    );
    assert.equal(
      await db
        .prepare(
          "SELECT review_state FROM treasury_readings WHERE source_url=?",
        )
        .bind(command.sourceUrl)
        .first("review_state"),
      "reviewed",
    );
  } finally {
    await runtime.dispose();
  }
});
test("treasury review refuses implicit promotion and bounds stalled or excessive candidate lists", async () => {
  for (const command of [
    { action: "list" as const },
    { action: "promote" as const, netuid: 1 },
    { action: "promote" as const, sourceUrl: "x", state: "reviewed" as const },
  ])
    await assert.rejects(
      promoteReading(command, 0, async () => []),
      /explicit/,
    );
  const results = Array.from({ length: 500 }, () => ({
    netuid: 7,
    source_url: "same",
    found: 1,
  }));
  await assert.rejects(
    listCandidates(async () => [{ results }]),
    /did not advance/,
  );
  let page = 0;
  await assert.rejects(
    listCandidates(async () => [
      { results: results.map((row) => ({ ...row, netuid: page++ })) },
    ]),
    /page budget/,
  );
});
