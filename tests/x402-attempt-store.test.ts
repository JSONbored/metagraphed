import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "vitest";
import { createX402AttemptStore } from "../src/x402-attempt-store.ts";

const databases: DatabaseSync[] = [];
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
});

const input = {
  identityKey: "eip155:8453:0xpayer:0xnonce",
  requestFingerprint: "a".repeat(64),
  facilitatorUrl: "https://facilitator.example/x402",
  envelope:
    '{ "paymentPayload": { "signature": "signed-value" },\n "amount": "1000" }',
  payer: "0xpayer",
};
const receipt = "eyJzdWNjZXNzIjp0cnVlLCJ0cmFuc2FjdGlvbiI6IjB4dHgifQ==";
const pending = { ...input, state: "pending", receipt: null };
type Hook = (text: string, values: unknown[]) => void;

// Exercise the tracked migration and real SQLite predicates. Hooks simulate
// transport failure before execution or after an auto-committed write.
function fixture(migrated = true) {
  const sql = new DatabaseSync(":memory:");
  databases.push(sql);
  if (migrated)
    sql.exec(
      readFileSync(
        new URL("../migrations/d1/0039_x402_payment_attempts.sql", import.meta.url),
        "utf8",
      ),
    );
  let before: Hook | undefined;
  let afterWrite: Hook | undefined;
  const prepare = (text: string, values: unknown[] = []) => ({
    bind(...next: unknown[]) {
      return prepare(text, next);
    },
    async first() {
      before?.(text, values);
      const row = sql.prepare(text).get(...(values as never[]));
      if (!/^\s*SELECT/.test(text)) afterWrite?.(text, values);
      return row ? { ...row } : null;
    },
  });
  const db = { prepare } as unknown as D1Database;
  return {
    sql,
    db,
    prepare,
    store: createX402AttemptStore(db)!,
    before(fn?: Hook) {
      before = fn;
    },
    committed(fn?: Hook) {
      afterWrite = fn;
    },
  };
}

test("an absent binding has no payment attempt store", () => {
  assert.equal(createX402AttemptStore(undefined), null);
});

test("an unknown payment identity has no attempt", async () => {
  const f = fixture();
  assert.equal(await f.store.get(input.identityKey), null);
});

test("the first binding preserves the exact facilitator envelope", async () => {
  const f = fixture();
  assert.deepEqual(await f.store.bind(input), pending);
  assert.deepEqual(await f.store.get(input.identityKey), pending);
  assert.equal(
    f.sql.prepare("SELECT envelope FROM x402_payment_attempts").get()?.envelope,
    input.envelope,
  );
});

test("a repeated binding cannot change any original settlement field", async () => {
  const f = fixture();
  await f.store.bind(input);
  assert.deepEqual(
    await f.store.bind({
      ...input,
      requestFingerprint: "b".repeat(64),
      facilitatorUrl: "https://replacement.example/x402",
      envelope: '{"changed":true}',
      payer: "another-payer",
    }),
    pending,
  );
  assert.deepEqual(await f.store.get(input.identityKey), pending);
});

test("overlapping binds all observe one durable original attempt", async () => {
  const f = fixture();
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      f.store.bind({ ...input, envelope: JSON.stringify({ index }) }),
    ),
  );
  assert.equal(
    f.sql.prepare("SELECT count(*) n FROM x402_payment_attempts").get()?.n,
    1,
  );
  for (const result of results) assert.deepEqual(result, results[0]);
  assert.deepEqual(await f.store.get(input.identityKey), results[0]);
});

test("only a matching pending attempt can claim paid execution", async () => {
  const f = fixture();
  await f.store.bind(input);
  assert.equal(
    await f.store.consume("unknown", input.requestFingerprint, receipt),
    false,
  );
  assert.equal(
    await f.store.consume(input.identityKey, "b".repeat(64), receipt),
    false,
  );
  assert.deepEqual(await f.store.get(input.identityKey), pending);
  assert.equal(
    await f.store.consume(input.identityKey, input.requestFingerprint, receipt),
    true,
  );
  assert.deepEqual(await f.store.get(input.identityKey), {
    ...pending,
    state: "consumed",
    envelope: null,
    receipt,
  });
});

test("overlapping execution claims have exactly one winner", async () => {
  const f = fixture();
  await f.store.bind(input);
  const claims = await Promise.all(
    Array.from({ length: 20 }, () =>
      f.store.consume(input.identityKey, input.requestFingerprint, receipt),
    ),
  );
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(claims.filter((claimed) => !claimed).length, 19);
});

test("consumed attempts retain their receipt and cannot be resurrected", async () => {
  const f = fixture();
  await f.store.bind(input);
  await f.store.consume(input.identityKey, input.requestFingerprint, receipt);
  assert.equal(
    await f.store.consume(input.identityKey, input.requestFingerprint, "changed"),
    false,
  );
  const consumed = { ...pending, state: "consumed", envelope: null, receipt };
  assert.deepEqual(
    await f.store.bind({ ...input, envelope: "replacement-envelope" }),
    consumed,
  );
  assert.deepEqual(await f.store.get(input.identityKey), consumed);
});

test("different payment identities have independent claims", async () => {
  const f = fixture();
  const second = { ...input, identityKey: "solana:mainnet:first-signature" };
  await Promise.all([f.store.bind(input), f.store.bind(second)]);
  assert.equal(
    await f.store.consume(input.identityKey, input.requestFingerprint, receipt),
    true,
  );
  assert.deepEqual(await f.store.get(second.identityKey), {
    ...pending,
    identityKey: second.identityKey,
  });
  assert.equal(
    await f.store.consume(second.identityKey, second.requestFingerprint, receipt),
    true,
  );
});

test("a missing migration fails closed without initializing runtime tables", async () => {
  const f = fixture(false);
  await assert.rejects(f.store.get(input.identityKey), /no such table/);
  await assert.rejects(f.store.bind(input), /no such table/);
  await assert.rejects(
    f.store.consume(input.identityKey, input.requestFingerprint, receipt),
    /no such table/,
  );
  assert.equal(
    f.sql
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .get(),
    undefined,
  );
});

test.each([
  "",
  "a".repeat(63),
  "a".repeat(65),
  "A".repeat(64),
  "z".repeat(64),
  "a".repeat(64) + "\0",
])(
  "the migration rejects an invalid request fingerprint: %s",
  async (requestFingerprint) => {
    const f = fixture();
    await assert.rejects(
      f.store.bind({ ...input, requestFingerprint }),
      /CHECK constraint failed/,
    );
    assert.equal(await f.store.get(input.identityKey), null);
  },
);

test.each([
  ["pending", null, null],
  ["pending", "envelope", "receipt"],
  ["consumed", "envelope", "receipt"],
  ["consumed", null, null],
  ["unknown", "envelope", null],
])("the migration rejects an inconsistent %s attempt", (state, envelope, saved) => {
  const f = fixture();
  assert.throws(
    () =>
      f.sql
        .prepare(
          `INSERT INTO x402_payment_attempts
          (identity_key,request_fingerprint,facilitator_url,payer,state,envelope,receipt)
          VALUES (?,?,?,?,?,?,?)`,
        )
        .run(
          input.identityKey,
          input.requestFingerprint,
          input.facilitatorUrl,
          input.payer,
          state,
          envelope,
          saved,
        ),
    /CHECK constraint failed/,
  );
});

test("a lost binding reply preserves the committed original for retry", async () => {
  const f = fixture();
  f.committed(() => {
    throw new Error("binding reply lost");
  });
  await assert.rejects(f.store.bind(input), /binding reply lost/);
  f.committed();
  assert.deepEqual(await f.store.get(input.identityKey), pending);
  assert.deepEqual(
    await f.store.bind({ ...input, envelope: "replacement-envelope" }),
    pending,
  );
});

test("a lost execution-claim reply cannot grant a second execution", async () => {
  const f = fixture();
  await f.store.bind(input);
  f.committed(() => {
    throw new Error("claim reply lost");
  });
  await assert.rejects(
    f.store.consume(input.identityKey, input.requestFingerprint, receipt),
    /claim reply lost/,
  );
  f.committed();
  assert.equal(
    await f.store.consume(input.identityKey, input.requestFingerprint, receipt),
    false,
  );
  assert.deepEqual(await f.store.get(input.identityKey), {
    ...pending,
    state: "consumed",
    envelope: null,
    receipt,
  });
});

test("statement failures propagate without changing the bound attempt", async () => {
  const f = fixture();
  await f.store.bind(input);
  f.before(() => {
    throw new Error("database unavailable");
  });
  await assert.rejects(f.store.get(input.identityKey), /database unavailable/);
  await assert.rejects(f.store.bind(input), /database unavailable/);
  await assert.rejects(
    f.store.consume(input.identityKey, input.requestFingerprint, receipt),
    /database unavailable/,
  );
  f.before();
  assert.deepEqual(await f.store.get(input.identityKey), pending);
});

test("an unacknowledged insert never reports a durable binding", async () => {
  const f = fixture();
  f.sql.exec(`CREATE TRIGGER decline_payment_attempt BEFORE INSERT
    ON x402_payment_attempts BEGIN SELECT RAISE(IGNORE); END`);
  await assert.rejects(f.store.bind(input), /Payment attempt was not acknowledged/);
  assert.equal(await f.store.get(input.identityKey), null);
});

test("a declined claim never grants execution", async () => {
  const f = fixture();
  await f.store.bind(input);
  f.sql.exec(`CREATE TRIGGER decline_payment_claim BEFORE UPDATE
    ON x402_payment_attempts BEGIN SELECT RAISE(IGNORE); END`);
  assert.equal(
    await f.store.consume(input.identityKey, input.requestFingerprint, receipt),
    false,
  );
  assert.deepEqual(await f.store.get(input.identityKey), pending);
});

test("a supported session starts at the primary and serves every operation", async () => {
  const f = fixture();
  const constraints: unknown[] = [];
  f.db.withSession = ((constraint: unknown) => {
    constraints.push(constraint);
    return { prepare: f.prepare };
  }) as D1Database["withSession"];
  f.db.prepare = () => {
    throw new Error("replica path used");
  };
  const store = createX402AttemptStore(f.db)!;
  assert.equal(await store.get(input.identityKey), null);
  assert.deepEqual(await store.bind(input), pending);
  assert.deepEqual(await store.bind(input), pending);
  assert.equal(
    await store.consume(input.identityKey, input.requestFingerprint, receipt),
    true,
  );
  assert.deepEqual(constraints, ["first-primary"]);
});
