import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test, vi } from "vitest";
import * as captureFamily from "../src/capture-family-d1.ts";
import { createD1Store } from "../src/d1-store.ts";
import { writeChainDetailD1 } from "../src/chain-detail-d1-write.ts";
import { parseChainDetailSync } from "../src/chain-detail-sync-payload.ts";
import { restoreChainDetailPayloads } from "../src/chain-detail-payloads.ts";
import { chainDetailTables } from "../src/chain-detail-neon-write.ts";

const stamp = 1790090000000;
const hash = `0x${"ab".repeat(32)}`;
function input(value: string, block = 9000001) {
  const parsed = parseChainDetailSync(
    {
      blocks: [
        {
          block_number: block,
          block_hash: hash,
          spec_version: 454,
          observed_at: stamp,
          extrinsics: [
            {
              block_number: block,
              extrinsic_index: 0,
              extrinsic_hash: hash,
              signer: null,
              call_module: "Test",
              call_function: "payload",
              success: true,
              fee_tao: null,
              tip_tao: null,
              call_args: value,
              observed_at: stamp,
            },
          ],
          chain_events: [],
          account_events: [],
        },
      ],
    },
    stamp,
  );
  assert.ok(parsed.ok);
  return parsed.rows;
}
function fixture(quota = 4 * 1024 * 1024) {
  const sql = new DatabaseSync(":memory:");
  for (const file of [
    "migrations/d1/0014_recent_chain_state.sql",
    "migrations/d1/0024_chain_detail_payload_chunks.sql",
    "deploy/chain-detail-payloads/sqlite.sql",
  ])
    sql.exec(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
  sql
    .prepare("UPDATE chain_detail_payload_budget SET max_encoded_bytes=?")
    .run(quota);
  let tail = Promise.resolve();
  const db = {
    prepare(text: string) {
      function prepared(values: unknown[] = []) {
        return {
          bind(...bindings: unknown[]) {
            return prepared(bindings);
          },
          async all() {
            return {
              results: sql.prepare(text).all(...(values as never[])),
              meta: { changes: 0 },
            };
          },
          async run() {
            const result = sql.prepare(text).run(...(values as never[]));
            return { meta: { changes: Number(result.changes) } };
          },
        };
      }
      return prepared();
    },
    batch(statements: { run(): Promise<unknown> }[]) {
      const result = tail.then(async () => {
        sql.exec("BEGIN");
        try {
          const results = [];
          for (const statement of statements)
            results.push(await statement.run());
          sql.exec("COMMIT");
          return results;
        } catch (error) {
          sql.exec("ROLLBACK");
          throw error;
        }
      });
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
  vi.stubGlobal(
    "CompressionStream",
    class extends TransformStream {
      constructor() {
        super({
          transform(chunk, controller) {
            controller.enqueue(chunk);
          },
        });
      }
    },
  );
  const env = { D1_STATE: db };
  const store = createD1Store(db as never);
  const count = (table: string) =>
    Number(sql.prepare(`SELECT count(*) n FROM ${table}`).get()!.n);
  const used = () =>
    Number(
      sql
        .prepare("SELECT used_encoded_bytes n FROM chain_detail_payload_budget")
        .get()!.n,
    );
  // Node22's experimental SQLite text conversion truncates a NUL-prefixed
  // token. Read its actual stored bytes so this fixture matches D1's lossless
  // string binding instead of silently passing an empty token to hydration.
  const rows = () =>
    sql
      .prepare(
        "SELECT block_number,CAST(call_args AS BLOB) call_args FROM chain_detail_extrinsics ORDER BY block_number",
      )
      .all()
      .map((row) => ({
        ...row,
        call_args:
          row.call_args === null
            ? null
            : Buffer.from(row.call_args as Uint8Array).toString("utf8"),
      }));
  return { sql, db, env, store, count, used, rows };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const ok = (result: Awaited<ReturnType<typeof writeChainDetailD1>>) =>
  Object.values(result).every((r) => r.ok);

test("chunks are pure preparation and commit with the full business capture", async () => {
  const f = fixture();
  try {
    const value = "界".repeat(50000);
    const transaction = f.store.transaction.bind(f.store);
    const spy = vi
      .spyOn(f.store, "transaction")
      .mockImplementation(async (statements) => {
        assert.equal(f.count("chain_detail_payload_chunks"), 0);
        assert.equal(f.count("chain_detail_extrinsics"), 0);
        assert.ok(statements.length <= 900);
        assert.ok(statements.every((s) => (s.values?.length ?? 0) <= 100));
        return transaction(statements);
      });
    assert.ok(ok(await writeChainDetailD1(f.store, f.env, input(value))));
    assert.equal(spy.mock.calls.length, 1);
    assert.equal(f.count("chain_detail_payload_chunks"), 1);
    assert.deepEqual(await restoreChainDetailPayloads(f.env, f.rows()), [
      { block_number: 9000001, call_args: value },
    ]);
  } finally {
    f.sql.close();
  }
});

test("repeated distinct failed hashes leave zero chunks, references or quota growth", async () => {
  const f = fixture();
  try {
    for (let index = 0; index < 4; index++) {
      const value = input(String(index).repeat(150000));
      value.blockRows[0].block_hash = null;
      assert.equal(ok(await writeChainDetailD1(f.store, f.env, value)), false);
      assert.equal(f.count("chain_detail_payload_chunks"), 0);
      assert.equal(f.used(), 0);
      for (const table of chainDetailTables()) assert.equal(f.count(table), 0);
    }
  } finally {
    f.sql.close();
  }
});

test("concurrent shared-hash success/failure preserves the successful exact original", async () => {
  for (const reverse of [false, true]) {
    const f = fixture();
    try {
      const value = "x".repeat(150000);
      const good = input(value),
        bad = input(value, 9000002);
      bad.blockRows[0].block_hash = null;
      const work = reverse ? [bad, good] : [good, bad];
      const results = await Promise.all(
        work.map((rows) => writeChainDetailD1(f.store, f.env, rows)),
      );
      assert.deepEqual(
        results.map(ok),
        reverse ? [false, true] : [true, false],
      );
      assert.equal(f.count("chain_detail_payload_chunks"), 1);
      const before = f.used();
      assert.ok(ok(await writeChainDetailD1(f.store, f.env, good)));
      assert.equal(f.used(), before);
      assert.deepEqual(await restoreChainDetailPayloads(f.env, f.rows()), [
        { block_number: 9000001, call_args: value },
      ]);
    } finally {
      f.sql.close();
    }
  }
});

test("lost acknowledgement replays exact chunks without additional quota", async () => {
  const f = fixture();
  try {
    const rows = input("x".repeat(150000));
    const transaction = f.store.transaction.bind(f.store);
    const lost = vi
      .spyOn(f.store, "transaction")
      .mockImplementationOnce(async (statements) => {
        await transaction(statements);
        throw new Error("lost acknowledgement");
      });
    assert.equal(ok(await writeChainDetailD1(f.store, f.env, rows)), false);
    const used = f.used();
    lost.mockRestore();
    assert.ok(ok(await writeChainDetailD1(f.store, f.env, rows)));
    assert.equal(f.used(), used);
    assert.equal(f.count("chain_detail_payload_chunks"), 1);
  } finally {
    f.sql.close();
  }
});

test("replacement and row pruning retain charged originals for in-flight hydration", async () => {
  const f = fixture();
  try {
    const old = "a".repeat(150000),
      current = "b".repeat(150000);
    assert.ok(ok(await writeChainDetailD1(f.store, f.env, input(old))));
    const inFlight = f.rows();
    assert.ok(
      ok(await writeChainDetailD1(f.store, f.env, input(old, 9000002))),
    );
    const shared = f.used();
    assert.ok(ok(await writeChainDetailD1(f.store, f.env, input(current))));
    assert.equal(f.used(), shared * 2);
    for (const table of chainDetailTables())
      f.sql.prepare(`DELETE FROM ${table}`).run();
    assert.equal(f.count("chain_detail_payload_chunks"), 2);
    assert.deepEqual(await restoreChainDetailPayloads(f.env, inFlight), [
      { block_number: 9000001, call_args: old },
    ]);
    assert.equal(
      f.used(),
      Number(
        f.sql
          .prepare(
            "SELECT sum(length(data)) n FROM chain_detail_payload_chunks",
          )
          .get()!.n,
      ),
    );
  } finally {
    f.sql.close();
  }
});

test("zero, missing and exhausted quota refuse new parts without changing business state", async () => {
  for (const mode of ["zero", "missing", "missing-table", "full"] as const) {
    const f = fixture(mode === "full" ? 200000 : 0);
    try {
      if (mode === "missing")
        f.sql.prepare("DELETE FROM chain_detail_payload_budget").run();
      if (mode === "missing-table")
        f.sql.exec("DROP TABLE chain_detail_payload_budget");
      if (mode === "full")
        assert.ok(
          ok(
            await writeChainDetailD1(f.store, f.env, input("a".repeat(150000))),
          ),
        );
      if (mode === "full")
        assert.ok(
          ok(
            await writeChainDetailD1(f.store, f.env, input("a".repeat(150000))),
          ),
        );
      const before = f.rows(),
        parts = f.count("chain_detail_payload_chunks");
      assert.equal(
        ok(await writeChainDetailD1(f.store, f.env, input("b".repeat(150000)))),
        false,
      );
      assert.deepEqual(f.rows(), before);
      assert.equal(f.count("chain_detail_payload_chunks"), parts);
    } finally {
      f.sql.close();
    }
  }
});

test("conflicting or extra stored parts reject publication atomically", async () => {
  for (const extra of [false, true]) {
    const f = fixture();
    try {
      const raw = Buffer.from("a".repeat(150000));
      const sha = createHash("sha256").update(raw).digest("hex");
      f.sql
        .prepare("INSERT INTO chain_detail_payload_chunks VALUES (?,?,?)")
        .run(sha, extra ? 1 : 0, "AAAA");
      const used = f.used();
      assert.equal(
        ok(await writeChainDetailD1(f.store, f.env, input(raw.toString()))),
        false,
      );
      assert.equal(f.count("chain_detail_extrinsics"), 0);
      assert.equal(f.count("chain_detail_payload_chunks"), 1);
      assert.equal(f.used(), used);
    } finally {
      f.sql.close();
    }
  }
});

test("oversized statement plans cannot commit a prepared chunk prefix", async () => {
  const f = fixture();
  try {
    const rows = input("a".repeat(150000));
    vi.spyOn(captureFamily, "captureUpsertStatements").mockReturnValue(
      Array.from({ length: 901 }, () => ({
        text: "SELECT json(?)",
        values: ["[]"] as [string],
      })),
    );
    const transaction = vi.spyOn(f.store, "transaction");
    assert.equal(ok(await writeChainDetailD1(f.store, f.env, rows)), false);
    assert.equal(transaction.mock.calls.length, 0);
    assert.equal(f.count("chain_detail_payload_chunks"), 0);
    assert.equal(f.used(), 0);
  } finally {
    f.sql.close();
  }
});
