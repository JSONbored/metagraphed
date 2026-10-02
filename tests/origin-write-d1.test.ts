import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, test } from "vitest";
import { Miniflare } from "miniflare";
import { createD1Store } from "../src/d1-store.ts";
import {
  persistOriginCheck,
  type OriginCheck,
  type OriginStoreDb,
} from "../src/origin-reachability.ts";

const runtime = new Miniflare({
  modules: true,
  script: "export default { fetch() { return new Response('test'); } }",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
const check: OriginCheck = {
  origin: "https://original.example",
  checked_at: 1_786_320_000_000,
  samples: [
    {
      url: "https://original.example/path",
      status: 200,
      body_hash: "original",
    },
  ],
  surface_ids: ["a", "b"],
  verdict: "serving",
};
const retained = {
  ...check,
  origin: "https://retained.example",
  checked_at: check.checked_at - 1,
};
beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  for (const migration of [
    "0004_probe_metadata.sql",
    "0016_archive_export_revisions.sql",
  ]) {
    const sql = readFileSync(
      new URL(`../migrations/d1/${migration}`, import.meta.url),
      "utf8",
    );
    for (const statement of sql.split("-- statement-breakpoint"))
      await db.prepare(statement).run();
  }
});
beforeEach(async () => {
  await db.prepare("DELETE FROM origin_reachability").run();
  await db.prepare("DELETE FROM archive_export_revisions").run();
  assert.deepEqual(
    await persistOriginCheck(
      createD1Store(db, ["origin_reachability"]),
      retained,
    ),
    { ok: true },
  );
});
afterAll(async () => {
  await runtime.dispose();
});

async function stored(expected = check, revision = 2) {
  const rows = await db
    .prepare("SELECT * FROM origin_reachability ORDER BY origin")
    .all();
  assert.deepEqual(
    rows.results,
    [expected, retained].map((row) => ({
      origin: row.origin,
      checked_at: row.checked_at,
      surface_count: row.surface_ids.length,
      samples: row.samples.length,
      verdict: row.verdict,
    })),
  );
  const revisions = await db
    .prepare("SELECT * FROM archive_export_revisions")
    .all();
  assert.deepEqual(revisions.results, [
    { table_name: "origin_reachability", revision },
  ]);
}

describe("origin write acknowledgement recovery", () => {
  for (const committed of [false, true]) {
    test(`a lost reply ${committed ? "after" : "before"} commit preserves the original check and export fence`, async () => {
      const native = createD1Store(db, ["origin_reachability"]);
      let writes = 0;
      const attempts: unknown[][] = [];
      const result = await persistOriginCheck(
        {
          ...native,
          async run(sql, values = []) {
            attempts.push([...values]);
            if (++writes === 1) {
              if (committed) await native.run(sql, values);
              throw new Error("D1_ERROR: Network connection lost.");
            }
            return native.run(sql, values);
          },
        },
        check,
      );
      assert.deepEqual(result, { ok: true });
      assert.equal(writes, committed ? 1 : 2);
      if (!committed) assert.deepEqual(attempts[0], attempts[1]);
      await stored();
    });
  }

  test("two lost replies can acknowledge the committed second write without a third write", async () => {
    const native = createD1Store(db, ["origin_reachability"]);
    let writes = 0;
    assert.deepEqual(
      await persistOriginCheck(
        {
          ...native,
          async run(sql, values) {
            if (++writes === 2) await native.run(sql, values);
            throw new Error("Network connection lost.");
          },
        },
        check,
      ),
      { ok: true },
    );
    assert.equal(writes, 2);
    await stored();
  });

  test("an identical queued check is acknowledged without changing the observation", async () => {
    const native = createD1Store(db, ["origin_reachability"]);
    assert.deepEqual(await persistOriginCheck(native, check), { ok: true });
    assert.deepEqual(await persistOriginCheck(native, check), { ok: true });
    await stored(check, 3);
  });

  test("a primary BIGINT string is compared without rounding its timestamp", async () => {
    let writes = 0;
    assert.deepEqual(
      await persistOriginCheck(
        {
          async run() {
            writes++;
            throw new Error("Network connection lost.");
          },
          async query<Row>() {
            return [{ checked_at: "9007199254740993" }] as Row[];
          },
        },
        check,
      ),
      { ok: true },
    );
    assert.equal(writes, 1);
  });

  test("a newer stored check acknowledges an older lost reply without replaying it", async () => {
    const native = createD1Store(db, ["origin_reachability"]);
    const newer: OriginCheck = {
      ...check,
      checked_at: check.checked_at + 1,
      verdict: "unreachable",
    };
    assert.deepEqual(await persistOriginCheck(native, newer), { ok: true });
    let writes = 0;
    assert.deepEqual(
      await persistOriginCheck(
        {
          ...native,
          async run() {
            writes++;
            throw new Error("Network connection lost.");
          },
        },
        check,
      ),
      { ok: true },
    );
    assert.equal(writes, 1);
    await stored(newer);
  });

  test("a newer check arriving between readback and replay cannot be overwritten", async () => {
    const native = createD1Store(db, ["origin_reachability"]);
    const newer: OriginCheck = {
      ...check,
      checked_at: check.checked_at + 1,
      verdict: "not-routing",
    };
    let writes = 0;
    assert.deepEqual(
      await persistOriginCheck(
        {
          ...native,
          async run(sql, values) {
            if (++writes === 1) throw new Error("Network connection lost.");
            assert.deepEqual(await persistOriginCheck(native, newer), {
              ok: true,
            });
            return native.run(sql, values);
          },
        },
        check,
      ),
      { ok: true },
    );
    assert.equal(writes, 2);
    await stored(newer, 3);
  });

  test("an older stored check is advanced by the same pinned observation", async () => {
    const native = createD1Store(db, ["origin_reachability"]);
    assert.deepEqual(
      await persistOriginCheck(native, {
        ...check,
        checked_at: check.checked_at - 1,
      }),
      { ok: true },
    );
    let writes = 0;
    assert.deepEqual(
      await persistOriginCheck(
        {
          ...native,
          async run(sql, values) {
            if (++writes === 1) throw new Error("Network connection lost.");
            return native.run(sql, values);
          },
        },
        check,
      ),
      { ok: true },
    );
    await stored(check, 3);
  });

  test("mutation of the caller's check cannot change a replayed observation", async () => {
    const native = createD1Store(db, ["origin_reachability"]);
    const mutable = {
      ...check,
      surface_ids: [...check.surface_ids],
      samples: [...check.samples],
    };
    let writes = 0;
    assert.deepEqual(
      await persistOriginCheck(
        {
          ...native,
          async run(sql, values) {
            if (++writes === 1) {
              mutable.checked_at++;
              mutable.surface_ids.push("changed");
              mutable.samples.length = 0;
              mutable.verdict = "unreachable";
              throw new Error("Network connection lost.");
            }
            return native.run(sql, values);
          },
        },
        mutable,
      ),
      { ok: true },
    );
    await stored();
  });

  for (const failure of [
    new Error("D1_ERROR: Too many requests"),
    new Error("D1_ERROR: no such table"),
    new Error("D1_ERROR: CHECK constraint failed"),
    new Error("D1_ERROR: Unauthorized"),
    "Network connection lost.",
    { message: "Network connection lost." },
  ]) {
    test(`an unclassified failure cannot authorize replay: ${String(failure)}`, async () => {
      let writes = 0,
        reads = 0;
      const result = await persistOriginCheck(
        {
          async run() {
            writes++;
            throw failure;
          },
          async query<Row>() {
            reads++;
            return [] as Row[];
          },
        },
        check,
      );
      assert.equal(result.ok, false);
      assert.equal(writes, 1);
      assert.equal(reads, 0);
    });
  }

  test("a persistent connection failure remains visible after two writes and two absent readbacks", async () => {
    let writes = 0,
      reads = 0;
    const result = await persistOriginCheck(
      {
        async run() {
          writes++;
          throw new Error("Network connection lost.");
        },
        async query<Row>() {
          reads++;
          return [] as Row[];
        },
      },
      check,
    );
    assert.deepEqual(result, {
      ok: false,
      reason: "write_failed: Network connection lost.",
    });
    assert.equal(writes, 2);
    assert.equal(reads, 2);
  });

  test("a failed primary readback prevents replay", async () => {
    let writes = 0;
    const result = await persistOriginCheck(
      {
        async run() {
          writes++;
          throw new Error("Network connection lost.");
        },
        async query() {
          throw new Error("readback unavailable");
        },
      },
      check,
    );
    assert.deepEqual(result, {
      ok: false,
      reason: "write_failed: readback unavailable",
    });
    assert.equal(writes, 1);
  });

  test("a store without readback cannot authorize replay", async () => {
    let writes = 0;
    assert.equal(
      (
        await persistOriginCheck(
          {
            async run() {
              writes++;
              throw new Error("Network connection lost.");
            },
          },
          check,
        )
      ).ok,
      false,
    );
    assert.equal(writes, 1);
  });

  for (const changed of [
    { surface_count: 99 },
    { samples: 99 },
    { verdict: "unreachable" },
  ]) {
    test(`a same-time conflicting stored observation cannot be acknowledged: ${JSON.stringify(changed)}`, async () => {
      const native = createD1Store(db, ["origin_reachability"]);
      assert.deepEqual(await persistOriginCheck(native, check), { ok: true });
      const columns = Object.keys(changed);
      await db
        .prepare(
          "UPDATE origin_reachability SET " + columns[0] + "=? WHERE origin=?",
        )
        .bind(Object.values(changed)[0], check.origin)
        .run();
      const result = await persistOriginCheck(native, check);
      assert.deepEqual(result, {
        ok: false,
        reason: "write_failed: Origin write readback identity differs",
      });
    });
  }

  test("duplicate primary rows cannot acknowledge a lost reply", async () => {
    const result = await persistOriginCheck(
      {
        async run() {
          throw new Error("Network connection lost.");
        },
        async query<Row>() {
          return [{}, {}] as Row[];
        },
      },
      check,
    );
    assert.deepEqual(result, {
      ok: false,
      reason: "write_failed: Origin write readback identity differs",
    });
  });

  for (const rows of [[], [{ checked_at: check.checked_at - 1 }]]) {
    test(`an unapplied write cannot claim success from an absent or older observation: ${JSON.stringify(rows)}`, async () => {
      const result = await persistOriginCheck(
        {
          async run() {
            return { changes: 0 };
          },
          async query<Row>() {
            return rows as Row[];
          },
        },
        check,
      );
      assert.deepEqual(result, {
        ok: false,
        reason: "write_failed: Origin write readback did not confirm the check",
      });
    });
  }

  test("an unapplied write without a primary readback stays a refusal", async () => {
    assert.deepEqual(
      await persistOriginCheck(
        {
          async run() {
            return { changes: 0 };
          },
        },
        check,
      ),
      { ok: false, reason: "write_failed: Origin write readback unavailable" },
    );
  });

  test("a different second-write error remains fatal without another read", async () => {
    let writes = 0,
      reads = 0;
    const result = await persistOriginCheck(
      {
        async run() {
          if (++writes === 1) throw new Error("Network connection lost.");
          throw new Error("D1_ERROR: CHECK constraint failed");
        },
        async query<Row>() {
          reads++;
          return [] as Row[];
        },
      } as OriginStoreDb,
      check,
    );
    assert.deepEqual(result, {
      ok: false,
      reason: "write_failed: D1_ERROR: CHECK constraint failed",
    });
    assert.equal(writes, 2);
    assert.equal(reads, 1);
  });
});
