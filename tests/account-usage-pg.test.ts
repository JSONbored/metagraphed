import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vitest";
import { createPgAccountUsage } from "../src/account-usage-pg.ts";
import type { PgStoreRuntime } from "../src/pg-store-runtime.ts";
import type { UsageRollupBucket } from "../src/usage-rollup-d1.ts";

const bucket = {
  day: "2026-11-04",
  family: "fixture",
  cost_shape: "edge",
  request_count: 1,
  keyed_count: 1,
};

function fixture(
  buckets: readonly UsageRollupBucket[] = [bucket],
  options: {
    now?: string;
    receipt?: { sha256: string; applied: boolean; expires_at: string } | null;
    current?: { requests: string; rejected?: string; keyed?: string } | null;
  } = {},
) {
  const writes: { text: string; values: unknown[] }[] = [];
  let calls = 0;
  const runtime: Pick<PgStoreRuntime, "transaction"> = {
    async transaction(callback, isolation) {
      calls += 1;
      assert.deepEqual(isolation, { isolation: "read committed" });
      return callback({
        async query<Row>() {
          return [] as Row[];
        },
        async first<Row>(text: string) {
          if (text.includes("clock_timestamp"))
            return { now: options.now ?? "1000" } as Row;
          if (text.includes("SELECT sha256"))
            return (
              Object.hasOwn(options, "receipt")
                ? options.receipt
                : {
                    sha256: createHash("sha256")
                      .update(JSON.stringify(buckets))
                      .digest("hex"),
                    applied: false,
                    expires_at: "601000",
                  }
            ) as Row | null;
          if (text.includes("SELECT request_count"))
            return (options.current ?? null) as Row | null;
          throw new Error("Unexpected read");
        },
        async run(text, values = []) {
          writes.push({ text, values });
          return { changes: 1 };
        },
      });
    },
  };
  return {
    runtime,
    writes,
    calls: () => calls,
    usage: createPgAccountUsage(runtime),
  };
}

test("daily increments preserve account identity and INTEGER/REAL addition", async () => {
  const first = fixture();
  await first.usage.increment({
    accountKind: "github",
    accountId: 0.1,
    day: bucket.day,
    route: "/fixture",
    rejected: false,
  });
  assert.deepEqual(first.writes[0].values.slice(2), [
    bucket.day,
    "/fixture",
    "1",
    "0",
  ]);
  assert.equal(first.writes[0].values[0], "github");
  const current = fixture([], {
    current: { requests: "9007199254740993", rejected: "0.5" },
  });
  await current.usage.increment({
    accountKind: "rpc",
    accountId: 42,
    day: bucket.day,
    route: "/fixture",
    rejected: true,
  });
  assert.deepEqual(current.writes[0].values.slice(4), [
    "9007199254740993",
    "1.5",
  ]);
});

test("rollup admission rejects oversized payloads and skips empty batches", async () => {
  const f = fixture();
  await f.usage.writeRollup([]);
  await assert.rejects(
    f.usage.writeRollup([{ ...bucket, family: "x".repeat(2 * 1024 * 1024) }]),
    /TEXT budget/,
  );
  assert.equal(f.calls(), 0);
});

test("rollups group JSON scalars and add to existing stored counters", async () => {
  const rows = [
    bucket,
    { ...bucket, request_count: 0.5, keyed_count: 0.1 },
    { ...bucket, family: "another" },
  ];
  const f = fixture(rows, {
    current: { requests: "9007199254740993", keyed: "0.5" },
  });
  await f.usage.writeRollup(rows, { now: () => 1000, batchId: "fixture" });
  const groups = f.writes.filter((write) =>
    write.text.startsWith("INSERT INTO app.api_usage_rollup("),
  );
  assert.equal(groups.length, 2);
  assert.equal(groups[0].values[1], "another");
  assert.equal(groups[0].values[3], "9007199254740994");
  assert.equal(groups[0].values[4], "1.5");
  assert.equal(groups[1].values[1], "fixture");
  assert.equal(groups[1].values[3], "9007199254740994");
  assert.equal(Number(groups[1].values[4]), 1.6);
  assert.ok(
    f.writes
      .at(-1)
      ?.text.startsWith("UPDATE app.api_usage_rollup_batches SET applied=true"),
  );
  const fresh = fixture();
  await fresh.usage.writeRollup([bucket]);
  assert.deepEqual(
    fresh.writes
      .find((write) =>
        write.text.startsWith("INSERT INTO app.api_usage_rollup("),
      )
      ?.values.slice(3),
    ["1", "1"],
  );
});

test("applied receipts do not increment again and invalid receipts refuse writes", async () => {
  const hash = createHash("sha256")
    .update(JSON.stringify([bucket]))
    .digest("hex");
  const replay = fixture([bucket], {
    receipt: { sha256: hash, applied: true, expires_at: "601000" },
  });
  await replay.usage.writeRollup([bucket]);
  assert.equal(
    replay.writes.some((write) =>
      write.text.startsWith("INSERT INTO app.api_usage_rollup("),
    ),
    false,
  );
  for (const receipt of [
    null,
    { sha256: "other", applied: false, expires_at: "601000" },
  ])
    await assert.rejects(
      fixture([bucket], { receipt }).usage.writeRollup([bucket]),
      /acknowledged/,
    );
  await assert.rejects(
    fixture([bucket], { now: "invalid" }).usage.writeRollup([bucket]),
    /clock/,
  );
  await assert.rejects(
    fixture([bucket], {
      receipt: { sha256: hash, applied: false, expires_at: "999" },
    }).usage.writeRollup([bucket]),
    /expired/,
  );
});

test("rollup groups follow SQLite binary tuple order", async () => {
  const rows = [
    { ...bucket, day: "2026-11-05", family: "a" },
    { ...bucket, family: "\u{10000}" },
    { ...bucket, family: "\uE000" },
    { ...bucket, family: "a", cost_shape: "z" },
    { ...bucket, family: "a", cost_shape: "a" },
    { ...bucket, family: "\n" },
  ];
  const f = fixture(rows);
  await f.usage.writeRollup(rows);
  assert.deepEqual(
    f.writes
      .filter((write) =>
        write.text.startsWith("INSERT INTO app.api_usage_rollup("),
      )
      .map((write) => write.values.slice(0, 3)),
    [
      [bucket.day, "\n", "edge"],
      [bucket.day, "a", "a"],
      [bucket.day, "a", "z"],
      [bucket.day, "\uE000", "edge"],
      [bucket.day, "\u{10000}", "edge"],
      ["2026-11-05", "a", "edge"],
    ],
  );
});

test("only connection failures retry a receipt-guarded rollup, at most once", async () => {
  for (const failure of [
    new Error("Connection terminated unexpectedly"),
    Object.assign(new Error("lost reply"), { code: "08006" }),
    Object.assign(new Error("reset"), { code: "ECONNRESET" }),
  ]) {
    const f = fixture();
    let calls = 0;
    const runtime: Pick<PgStoreRuntime, "transaction"> = {
      async transaction(callback, options) {
        calls += 1;
        if (calls === 1) throw failure;
        return f.runtime.transaction(callback, options);
      },
    };
    await createPgAccountUsage(runtime).writeRollup([bucket]);
    assert.equal(calls, 2);
  }
  for (const failure of [
    null,
    "failed",
    {},
    new Error("bad data"),
    { code: 7 },
    { code: "23514" },
  ]) {
    let calls = 0;
    const usage = createPgAccountUsage({
      async transaction() {
        calls += 1;
        throw failure;
      },
    });
    await assert.rejects(
      usage.writeRollup([bucket]),
      (error: unknown) => error === failure,
    );
    assert.equal(calls, 1);
  }
  let calls = 0;
  const failure = Object.assign(new Error("still unavailable"), {
    code: "EPIPE",
  });
  await assert.rejects(
    createPgAccountUsage({
      async transaction() {
        calls += 1;
        throw failure;
      },
    }).writeRollup([bucket]),
    /still unavailable/,
  );
  assert.equal(calls, 2);
});
