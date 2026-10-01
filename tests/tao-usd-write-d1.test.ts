import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, test } from "vitest";
import { Miniflare } from "miniflare";
import { createD1Store } from "../src/d1-store.ts";
import type { ProducerStore } from "../src/producer-store.ts";
import type { TaoUsdIndexRow } from "../src/tao-usd-ingest.ts";
import { writeTaoUsdIndexD1 } from "../src/tao-usd-write-d1.ts";

const runtime = new Miniflare({
  modules: true,
  script: "export default { fetch() { return new Response('test'); } }",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
const observation: TaoUsdIndexRow = {
  block_number: 25_650_836,
  observed_at: 1_785_476_783_000,
  usd_per_tao: 195.52,
  price_basis: "wrapped_onchain_median",
  eth_usd: 3000,
  pool_count: 2,
  pools: [{ address: "original-pool", included: true, eth_per_tao: 0.065 }],
};
const older = { ...observation, block_number: observation.block_number - 1 };
beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  for (const migration of [
    "0011_economic_reference_state.sql",
    "0016_archive_export_revisions.sql",
  ]) {
    const sql = readFileSync(
      new URL(`../migrations/d1/${migration}`, import.meta.url),
      "utf8",
    );
    for (const statement of sql.split("-- statement-breakpoint")) {
      await db.prepare(statement).run();
    }
  }
});
beforeEach(async () => {
  await db.prepare("DELETE FROM tao_usd_index").run();
  await db.prepare("DELETE FROM archive_export_revisions").run();
  await writeTaoUsdIndexD1(createD1Store(db, ["tao_usd_index"]), older);
});
afterAll(async () => {
  await runtime.dispose();
});

async function assertHistoryAndRevision(expected = observation) {
  const rows = await db
    .prepare("SELECT * FROM tao_usd_index ORDER BY block_number")
    .all();
  assert.deepEqual(
    rows.results,
    [older, expected].map((row) => ({
      ...row,
      pools: JSON.stringify(row.pools),
    })),
  );
  const revisions = await db
    .prepare("SELECT table_name,revision FROM archive_export_revisions")
    .all();
  assert.deepEqual(revisions.results, [
    { table_name: "tao_usd_index", revision: 2 },
  ]);
}

describe("TAO/USD native write acknowledgement recovery", () => {
  test("successful writes preserve the historical series and atomically advance its export fence", async () => {
    await writeTaoUsdIndexD1(createD1Store(db, ["tao_usd_index"]), observation);
    await assertHistoryAndRevision();
  });

  test("an unpriceable observation retains null and its original audit trail", async () => {
    const row: TaoUsdIndexRow = {
      ...observation,
      usd_per_tao: null,
      eth_usd: null,
      price_basis: "insufficient_pools",
      pool_count: 0,
      pools: [],
    };
    await writeTaoUsdIndexD1(createD1Store(db, ["tao_usd_index"]), row);
    await assertHistoryAndRevision(row);
  });

  for (const afterCommit of [false, true]) {
    test(`a lost reply ${afterCommit ? "after" : "before"} commit recovers the same observation exactly once`, async () => {
      let writes = 0;
      const attempts: string[] = [];
      const native = createD1Store(db, ["tao_usd_index"]);
      const store = {
        first: native.first,
        run: async (text: string, values?: unknown[]) => {
          writes++;
          attempts.push(JSON.stringify({ text, values }));
          if (writes === 1) {
            if (afterCommit) await native.run(text, values);
            throw new Error("D1_ERROR: Network connection lost.");
          }
          return native.run(text, values);
        },
      };
      await writeTaoUsdIndexD1(store, observation);
      assert.equal(writes, afterCommit ? 1 : 2);
      if (!afterCommit) assert.equal(attempts[0], attempts[1]);
      await assertHistoryAndRevision();
    });
  }

  test("a duplicate observation never replaces its original provenance", async () => {
    await writeTaoUsdIndexD1(createD1Store(db), observation);
    await writeTaoUsdIndexD1(createD1Store(db), {
      ...observation,
      pools: [],
      usd_per_tao: 999,
    });
    const row = await db
      .prepare(
        "SELECT usd_per_tao,pools FROM tao_usd_index WHERE block_number=? AND observed_at=?",
      )
      .bind(observation.block_number, observation.observed_at)
      .first();
    assert.deepEqual(row, {
      usd_per_tao: observation.usd_per_tao,
      pools: JSON.stringify(observation.pools),
    });
  });

  for (const error of [
    new Error("D1_ERROR: no such table: tao_usd_index"),
    new Error("D1_ERROR: CHECK constraint failed"),
    new Error("D1_ERROR: Database storage limit exceeded"),
    new Error("D1_ERROR: Too many requests"),
    new Error("D1_ERROR: Unauthorized"),
    "Network connection lost.",
  ]) {
    test(`a permanent or unclassified failure is propagated: ${String(error)}`, async () => {
      let writes = 0,
        reads = 0;
      const store = {
        run: async () => {
          writes++;
          throw error;
        },
        first: async () => {
          reads++;
          return null;
        },
      } as Pick<ProducerStore, "run" | "first">;
      await assert.rejects(
        writeTaoUsdIndexD1(store, observation),
        (caught) => caught === error,
      );
      assert.equal(writes, 1);
      assert.equal(reads, 0);
    });
  }

  test("a persistent write failure is attempted only twice and remains a failure", async () => {
    const error = new Error("D1_ERROR: Replica disconnected from primary.");
    let writes = 0,
      reads = 0;
    const store = {
      run: async () => {
        writes++;
        throw error;
      },
      first: async () => {
        reads++;
        return null;
      },
    } as Pick<ProducerStore, "run" | "first">;
    await assert.rejects(
      writeTaoUsdIndexD1(store, observation),
      (caught) => caught === error,
    );
    assert.equal(writes, 2);
    assert.equal(reads, 1);
  });

  test("a failed readback cannot invent a commit or hide the outage", async () => {
    const error = new Error("D1_ERROR: Network connection lost.");
    let writes = 0;
    const store = {
      run: async () => {
        writes++;
        throw error;
      },
      first: async () => {
        throw error;
      },
    } as Pick<ProducerStore, "run" | "first">;
    await assert.rejects(
      writeTaoUsdIndexD1(store, observation),
      (caught) => caught === error,
    );
    assert.equal(writes, 1);
  });

  test("an acknowledgement for a different timestamp cannot count as this commit", async () => {
    let writes = 0;
    const store = {
      run: async () => {
        writes++;
        if (writes === 1) throw new Error("Network connection lost.");
        return { changes: 1 };
      },
      first: async () => ({
        block_number: observation.block_number,
        observed_at: observation.observed_at - 1,
      }),
    } as Pick<ProducerStore, "run" | "first">;
    await writeTaoUsdIndexD1(store, observation);
    assert.equal(writes, 2);
  });
});
