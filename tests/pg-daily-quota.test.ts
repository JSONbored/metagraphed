import assert from "node:assert/strict";
import { test } from "vitest";
import { createPgDailyQuota } from "../src/pg-daily-quota.ts";
import { selectedDailyQuotaStore } from "../src/daily-quota-store.ts";
import type { PgKvRuntime } from "../src/pg-kv.ts";
import worker from "../workers/data-api.ts";

function fixture(initial: string | null = null) {
  let stored = initial,
    writes = 0,
    transactions = 0;
  const runtime: Pick<PgKvRuntime, "transaction"> = {
    async transaction(callback, options) {
      transactions += 1;
      assert.deepEqual(options, { isolation: "read committed" });
      return callback({
        async query() {
          return [];
        },
        async first<Row>() {
          return (stored === null ? null : { used: stored }) as Row | null;
        },
        async run(text, values = []) {
          if (text.startsWith("INSERT")) {
            writes += 1;
            stored = String(values[3]);
          }
          return { changes: 1 };
        },
      });
    },
  };
  return {
    store: createPgDailyQuota(runtime),
    value: () => stored,
    writes: () => writes,
    transactions: () => transactions,
  };
}
const input = {
  accountKind: "rpc" as const,
  accountId: 1,
  cost: 1,
  limit: 10,
  nowMs: Date.UTC(2026, 10, 4),
};

test("quota preserves exact stored arithmetic and the existing separately-rounded wire result", async () => {
  const f = fixture();
  assert.equal((await f.store.spend(input)).used, 1);
  assert.equal(f.value(), "1");
  assert.equal((await f.store.spend({ ...input, cost: 0.1 })).used, 1.1);
  assert.equal(
    f.value(),
    "1.100000000000000088817841970012523233890533447265625",
  );
  assert.equal((await f.store.spend({ ...input, cost: 10 })).allowed, false);
  assert.equal(f.writes(), 2);
  const big = fixture("9007199254740992");
  // The exact INTEGER sum exceeds this bound, although the legacy HTTP
  // response's separate binary64 arithmetic still rounds to allowed=true.
  assert.equal(
    (await big.store.spend({ ...input, limit: 9007199254740992 })).allowed,
    true,
  );
  assert.equal(big.value(), "9007199254740992");
  assert.equal(big.writes(), 0);
  await big.store.spend({ ...input, limit: 9007199254740994 });
  assert.equal(big.value(), "9007199254740993");
  const over = fixture("9223372036854775807");
  await over.store.spend({ ...input, limit: 1e20 });
  assert.equal(over.value(), "9223372036854775808.0");
  const minimumInteger = fixture("-9223372036854775808");
  const minimumReal = fixture("-9223372036854775808.0");
  await minimumInteger.store.spend(input);
  await minimumReal.store.spend(input);
  assert.equal(minimumInteger.value(), "-9223372036854775807");
  assert.equal(minimumReal.value(), "-9223372036854775808.0");
});

test("quota rejects malformed inputs and avoids storage for an oversized first cost", async () => {
  const f = fixture();
  assert.equal((await f.store.spend({ ...input, cost: 11 })).allowed, false);
  assert.equal(f.transactions(), 0);
  for (const value of [
    { accountId: 0 },
    { accountId: 0.1 },
    { accountId: Infinity },
    { accountKind: "unknown" },
    { cost: -1 },
    { cost: Infinity },
    { limit: 0 },
    { limit: Infinity },
  ]) {
    await assert.rejects(
      f.store.spend({ ...input, ...value } as typeof input),
      /Invalid daily quota input/,
    );
  }
  await assert.rejects(f.store.spend({ ...input, nowMs: NaN }));
  for (const absent of [null, undefined, false, "invalid", {}])
    assert.equal(selectedDailyQuotaStore(absent), null);
  for (const value of [null, {}, { spend: true }])
    assert.throws(
      () => selectedDailyQuotaStore({ DAILY_QUOTA_STORE: value }),
      /incomplete/,
    );
  assert.equal(
    selectedDailyQuotaStore({ DAILY_QUOTA_STORE: f.store }),
    f.store,
  );
});

test("the existing internal quota HTTP route selects native ownership and retains its error response", async () => {
  const f = fixture();
  const token = "fixture-internal";
  const request = () =>
    new Request("https://data.example.com/api/v1/internal/keys/quota", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key-lookup-token": token,
      },
      body: JSON.stringify({
        account_id: 1,
        account_kind: "github",
        cost: 0.1,
        limit: 1,
      }),
    });
  const env = {
    API_KEY_LOOKUP_INTERNAL_TOKEN: token,
    DAILY_QUOTA_STORE: f.store,
  } as unknown as DataApiEnv;
  const ctx = { waitUntil() {} } as unknown as ExecutionContext;
  const response = await worker.fetch(request(), env, ctx);
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { used: number }).used, 0.1);
  const failed = await worker.fetch(
    request(),
    {
      ...env,
      DAILY_QUOTA_STORE: {
        spend: async () => {
          throw new Error("fixture database failure");
        },
      },
    } as unknown as DataApiEnv,
    ctx,
  );
  assert.equal(failed.status, 502);
  assert.deepEqual(await failed.json(), { error: "write failed" });
});
