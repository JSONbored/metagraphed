import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, afterAll, test } from "vitest";
import {
  createPgChainFirehoseStore,
  parseChainState,
} from "../src/pg-chain-firehose-store.ts";
import {
  chainFixture,
  chainStateLimits,
} from "./helpers/chain-firehose-fixture.ts";
let db: PGlite;
let f: Awaited<ReturnType<typeof chainFixture>>;
beforeAll(() => {
  db = new PGlite();
});
beforeEach(async () => {
  f = await chainFixture(db);
});
afterAll(async () => {
  await db.close();
});
const row = async () =>
  (
    await db.query<Record<string, unknown>>(
      "SELECT * FROM realtime.chain_firehose_actor",
    )
  ).rows[0]!;

test("state limits and keys are checked while source cursor repair remains available", async () => {
  for (const name of ["maxStateBytes", "leaseMilliseconds"] as const)
    for (const value of [0, NaN, Infinity, 0.5])
      await assert.rejects(
        createPgChainFirehoseStore(f.runtime, {
          ...chainStateLimits,
          [name]: value,
        }),
        /Invalid chain/,
      );
  await assert.rejects(
    createPgChainFirehoseStore(f.runtime, {
      ...chainStateLimits,
      maxStateBytes: 123,
    }),
    /capacity/,
  );
  for (const text of [
    "null",
    "[]",
    "broken",
    '{"unexpected":1}',
    '{"mcp:subscribed-sessions":"not an array"}',
    '{"mcp:subscribed-sessions":[7]}',
  ])
    assert.throws(() => parseChainState(text));
  assert.deepEqual(parseChainState('{"head:last_seen":"old-invalid-cursor"}'), {
    "head:last_seen": "old-invalid-cursor",
  });
  assert.deepEqual(parseChainState("{}"), {});
});

test("one lease exclusively protects membership and independent head cursors across takeover", async () => {
  const first = (await f.store.acquire())!;
  const peer = await createPgChainFirehoseStore(f.runtime, chainStateLimits);
  assert.equal(await peer.acquire(), null);
  const state = JSON.stringify({
    "mcp:subscribed-sessions": ["a\u0000b\ud800"],
    "head:last_seen": 50,
    "head:write_next": 25,
  });
  await f.store.save(first, state);
  assert.equal((await row()).state, state);
  await db.exec("UPDATE realtime.chain_firehose_actor SET lease_until_ms=0");
  const second = (await peer.acquire())!;
  assert.notEqual(second.token, first.token);
  await assert.rejects(f.store.save(first, "{}"), /ownership/);
  await assert.rejects(f.store.renew(first), /ownership/);
  await f.store.release(first);
  assert.equal((await row()).owner_token, second.token);
  const clock = await peer.renew(second);
  assert.ok(clock.expiresAtMs > clock.nowMs);
  await peer.release(second);
  assert.equal((await row()).owner_token, null);
});

test("alarm settlement preserves a later re-arm and old tokens cannot settle takeover work", async () => {
  const owner = (await f.store.acquire())!;
  assert.equal(await f.store.alarmTime(owner), null);
  assert.equal(await f.store.claimAlarm(owner), null);
  await f.store.setAlarm(owner, 0);
  const claim = (await f.store.claimAlarm(owner))!;
  assert.equal(await f.store.claimAlarm(owner), null);
  await f.store.setAlarm(owner, Date.now() + 60000);
  assert.equal(await f.store.settleAlarm(owner, claim, false), true);
  assert.equal((await row()).alarm_outcome, "pending");
  assert.ok((await f.store.alarmTime(owner))! > Date.now());
  await f.store.setAlarm(owner, 0);
  const old = (await f.store.claimAlarm(owner))!;
  await db.exec("UPDATE realtime.chain_firehose_actor SET lease_until_ms=0");
  const next = (await f.store.acquire())!;
  await assert.rejects(f.store.settleAlarm(owner, old, false), /ownership/);
  const current = (await f.store.claimAlarm(next))!;
  assert.equal(
    await f.store.settleAlarm(next, { ...current, token: old.token }, false),
    false,
  );
  assert.equal(await f.store.settleAlarm(next, current, false), true);
  assert.equal((await row()).alarm_outcome, "completed");
});

test("failed alarm attempts retry finitely and a new alarm clears exhaustion", async () => {
  const owner = (await f.store.acquire())!;
  for (let attempt = 1; attempt <= 6; attempt++) {
    await db.exec("UPDATE realtime.chain_firehose_actor SET alarm_at_ms=0");
    const claim = (await f.store.claimAlarm(owner))!;
    assert.equal(await f.store.settleAlarm(owner, claim, true), true);
    assert.equal((await row()).alarm_attempts, attempt);
    assert.equal(
      (await row()).alarm_outcome,
      attempt === 6 ? "exhausted" : "retry",
    );
  }
  await db.exec("UPDATE realtime.chain_firehose_actor SET alarm_at_ms=0");
  assert.equal(await f.store.claimAlarm(owner), null);
  await f.store.setAlarm(owner, 0);
  assert.equal((await row()).alarm_attempts, 0);
  for (const value of [-1, NaN, 0.5])
    await assert.rejects(f.store.setAlarm(owner, value), /alarm time/);
  await assert.rejects(
    f.store.save(
      owner,
      JSON.stringify({ "mcp:subscribed-sessions": ["x".repeat(131072)] }),
    ),
    /capacity/,
  );
});
