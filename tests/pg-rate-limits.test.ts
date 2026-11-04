import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createPgRateLimits as buildPgRateLimits,
  type NativeRateLimitDefinition,
} from "../src/pg-rate-limits.ts";
import type { PgKvRuntime } from "../src/pg-kv.ts";

const createPgRateLimits = (
  runtime: PgKvRuntime,
  definitions: readonly NativeRateLimitDefinition[],
) => buildPgRateLimits(runtime, definitions, () => {});

function fixture() {
  let now = 1000;
  const policies = new Map<
    string,
    { request_limit: number; period_seconds: number }
  >();
  let missingPolicy = false;
  const buckets = new Map<
    string,
    {
      binding: string;
      key: Buffer;
      second: number;
      count: number;
      expires: number;
    }
  >();
  let pending = Promise.resolve();
  let badClock: unknown, badUsed: unknown;
  let clockMissing = false,
    usedMissing = false;
  const id = (binding: unknown, key: unknown, second: unknown) =>
    `${binding}:${(key as Buffer).toString("hex")}:${second}`;
  const runtime: PgKvRuntime = {
    producer: {
      async query() {
        return [];
      },
      async first() {
        return null;
      },
      async run(_text, values = []) {
        let removed = 0;
        for (const [key, bucket] of buckets) {
          if (bucket.expires <= now && removed < Number(values[0])) {
            buckets.delete(key);
            removed += 1;
          }
        }
        return { changes: removed };
      },
    },
    async transaction(callback, options) {
      assert.deepEqual(options, { isolation: "read committed" });
      const result = pending.then(() =>
        callback({
          async query() {
            return [];
          },
          async first<Row>(text: string, values: unknown[] = []) {
            if (text.includes("FROM auth.rate_limit_policies"))
              return (
                missingPolicy ? null : (policies.get(String(values[0])) ?? null)
              ) as Row | null;
            if (text.includes("AS second"))
              return (
                clockMissing ? null : { second: badClock ?? String(now) }
              ) as Row | null;
            const [binding, key, after] = values;
            const used = [...buckets.values()]
              .filter(
                (b) =>
                  b.binding === binding &&
                  b.key.equals(key as Buffer) &&
                  b.second >= Number(after),
              )
              .reduce((total, b) => total + b.count, 0);
            return (
              usedMissing ? null : { used: badUsed ?? String(used) }
            ) as Row | null;
          },
          async run(text, values = []) {
            if (text.startsWith("SET")) return { changes: 0 };
            if (text.startsWith("INSERT INTO auth.rate_limit_policies")) {
              if (!policies.has(String(values[0])))
                policies.set(String(values[0]), {
                  request_limit: Number(values[1]),
                  period_seconds: Number(values[2]),
                });
              return { changes: 1 };
            }
            if (text.startsWith("WITH expired")) {
              let removed = 0;
              for (const [key, bucket] of buckets) {
                if (bucket.expires <= now && removed < Number(values[0])) {
                  buckets.delete(key);
                  removed += 1;
                }
              }
              return { changes: removed };
            }
            const [binding, key, second, expiry] = values;
            if (text.startsWith("DELETE")) {
              for (const [name, b] of buckets)
                if (
                  b.binding === binding &&
                  b.key.equals(key as Buffer) &&
                  b.second < Number(second)
                )
                  buckets.delete(name);
            } else {
              const name = id(binding, key, second);
              const bucket = buckets.get(name);
              if (bucket) bucket.count += 1;
              else
                buckets.set(name, {
                  binding: String(binding),
                  key: key as Buffer,
                  second: Number(second),
                  count: 1,
                  expires: Number(expiry),
                });
            }
            return { changes: 1 };
          },
        }),
      );
      pending = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
  return {
    runtime,
    buckets,
    missingPolicy: (value = true) => {
      missingPolicy = value;
    },
    time: (value: number) => {
      now = value;
    },
    corrupt: (clock: unknown, used: unknown) => {
      badClock = clock;
      badUsed = used;
    },
    missing: (clock: boolean, used: boolean) => {
      clockMissing = clock;
      usedMissing = used;
    },
  };
}

test("native windows isolate bindings and keys, serialize draws and retain the whole boundary second", async () => {
  const f = fixture();
  const { bindings } = createPgRateLimits(f.runtime, [
    { binding: "FIRST", limit: 2, period: 60 },
    { binding: "SECOND", limit: 1, period: 10 },
  ]);
  const outcomes = await Promise.all(
    [1, 2, 3].map(() => bindings.FIRST.limit({ key: "account\0λ" })),
  );
  assert.deepEqual(outcomes, [
    { success: true },
    { success: true },
    { success: false },
  ]);
  assert.deepEqual(await bindings.SECOND.limit({ key: "account\0λ" }), {
    success: true,
  });
  assert.deepEqual(await bindings.FIRST.limit({ key: "different" }), {
    success: true,
  });
  f.time(1060);
  assert.deepEqual(await bindings.FIRST.limit({ key: "account\0λ" }), {
    success: false,
  });
  f.time(999);
  assert.deepEqual(await bindings.FIRST.limit({ key: "account\0λ" }), {
    success: false,
  });
  f.time(1061);
  assert.deepEqual(await bindings.FIRST.limit({ key: "account\0λ" }), {
    success: true,
  });
  assert.equal(
    [...f.buckets.values()].filter(
      (b) => b.binding === "FIRST" && b.key.equals(Buffer.from("account\0λ")),
    ).length,
    1,
  );
});

test("policy, key and stored-counter bounds fail explicitly", async () => {
  const f = fixture();
  assert.throws(() => createPgRateLimits(f.runtime, []), /required/);
  for (const policy of [
    { binding: "bad", limit: 1, period: 60 },
    { binding: "OK", limit: 0, period: 60 },
    { binding: "OK", limit: 2147483648, period: 60 },
    { binding: "OK", limit: 1, period: 1 },
  ]) {
    assert.throws(
      () =>
        createPgRateLimits(f.runtime, [
          policy as { binding: string; limit: number; period: 60 },
        ]),
      /Invalid native rate policy/,
    );
  }
  assert.throws(
    () =>
      createPgRateLimits(f.runtime, [
        { binding: "A", limit: 1, period: 10 },
        { binding: "A", limit: 1, period: 10 },
      ]),
    /Invalid native rate policy/,
  );
  const api = createPgRateLimits(f.runtime, [
    { binding: "A", limit: 1, period: 10 },
  ]);
  for (const key of [null, "", "x".repeat(1025), "\ud800"])
    await assert.rejects(api.bindings.A.limit({ key: key as string }));
  for (const value of [
    null,
    {},
    "bad",
    "-1",
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    f.corrupt(value, undefined);
    if (value === null) f.missing(true, false);
    assert.deepEqual(await api.bindings.A.limit({ key: "valid" }), {
      success: false,
    });
    f.missing(false, false);
  }
  f.corrupt(Number.MAX_SAFE_INTEGER, undefined);
  assert.deepEqual(await api.bindings.A.limit({ key: "valid" }), {
    success: false,
  });
  f.corrupt(undefined, "bad");
  assert.deepEqual(await api.bindings.A.limit({ key: "valid" }), {
    success: false,
  });
  f.corrupt(undefined, undefined);
  f.missing(false, true);
  assert.deepEqual(await api.bindings.A.limit({ key: "valid" }), {
    success: false,
  });
});

test("housekeeping deletes only the requested expired budget", async () => {
  const f = fixture();
  const api = createPgRateLimits(f.runtime, [
    { binding: "A", limit: 2, period: 10 },
  ]);
  await api.bindings.A.limit({ key: "one" });
  await api.bindings.A.limit({ key: "two" });
  f.time(1011);
  assert.equal(await api.pruneExpired(1), 1);
  assert.equal(await api.pruneExpired(), 1);
  assert.equal(await api.pruneExpired(), 0);
  await assert.rejects(api.pruneExpired(0), /pruning budget/);
  await assert.rejects(api.pruneExpired(10001), /pruning budget/);
});

test("unavailable native counters deny admission even when their error reporter fails", async () => {
  const f = fixture();
  const policy = [{ binding: "A", limit: 1, period: 60 as const }];
  assert.throws(
    () => buildPgRateLimits(f.runtime, policy, undefined as never),
    /reporting is required/,
  );
  let reported = 0;
  const runtime: PgKvRuntime = {
    ...f.runtime,
    async transaction() {
      throw new Error("pool capacity");
    },
  };
  const api = buildPgRateLimits(runtime, policy, (error, binding) => {
    assert.match(String(error), /pool capacity/);
    assert.equal(binding, "A");
    reported += 1;
    throw new Error("reporter failed");
  });
  assert.deepEqual(await api.bindings.A.limit({ key: "caller" }), {
    success: false,
  });
  assert.equal(reported, 1);
});

test("persisted policy mismatches deny draws and housekeeping before changing counters", async () => {
  const f = fixture();
  const expected = createPgRateLimits(f.runtime, [
    { binding: "A", limit: 1, period: 60 },
  ]);
  assert.deepEqual(await expected.bindings.A.limit({ key: "caller" }), {
    success: true,
  });
  f.time(2000);
  for (const changed of [
    { binding: "A", limit: 2, period: 60 as const },
    { binding: "A", limit: 1, period: 10 as const },
  ]) {
    const mismatch = createPgRateLimits(f.runtime, [changed]);
    assert.deepEqual(await mismatch.bindings.A.limit({ key: "caller" }), {
      success: false,
    });
    await assert.rejects(mismatch.pruneExpired(), /policy differs/);
    assert.equal(f.buckets.size, 1);
  }
  const missing = fixture();
  missing.missingPolicy();
  const missingApi = createPgRateLimits(missing.runtime, [
    { binding: "A", limit: 1, period: 60 },
  ]);
  assert.deepEqual(await missingApi.bindings.A.limit({ key: "caller" }), {
    success: false,
  });
  assert.equal(missing.buckets.size, 0);
  missing.missingPolicy(false);
  assert.deepEqual(await missingApi.bindings.A.limit({ key: "caller" }), {
    success: true,
  });
  missing.missingPolicy();
  assert.deepEqual(await missingApi.bindings.A.limit({ key: "other" }), {
    success: false,
  });
  const unordered = fixture();
  assert.equal(
    await createPgRateLimits(unordered.runtime, [
      { binding: "C", limit: 1, period: 60 },
      { binding: "A", limit: 1, period: 60 },
      { binding: "B", limit: 1, period: 60 },
    ]).pruneExpired(),
    0,
  );
});
