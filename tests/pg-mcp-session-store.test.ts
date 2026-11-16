import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, test } from "vitest";
import {
  createPgMcpSessionStore,
  mcpSessionKey,
  parseMcpSessionState,
} from "../src/pg-mcp-session-store.ts";
import { mcpFixture, mcpLimits } from "./helpers/mcp-session-fixture.ts";
let db: PGlite;
let f: Awaited<ReturnType<typeof mcpFixture>>;
beforeAll(() => {
  db = new PGlite();
});
beforeEach(async () => {
  f = await mcpFixture(db);
});
afterAll(async () => {
  await db.close();
});
const row = async () =>
  (
    await db.query<Record<string, unknown>>(
      "SELECT * FROM realtime.mcp_sessions",
    )
  ).rows[0]!;

test("validates capacity, bounded state and JSON-text session identity", async () => {
  for (const [key, values] of Object.entries({
    maxSessions: [0, 100001, NaN],
    maxBytes: [0, 1073741825, Infinity],
    maxStateBytes: [0, 131073, 0.5],
    leaseMilliseconds: [0, 3600001, NaN],
  }))
    for (const value of values)
      await assert.rejects(
        createPgMcpSessionStore(f.runtime, { ...mcpLimits, [key]: value }),
        /Invalid MCP/,
      );
  await assert.rejects(
    createPgMcpSessionStore(f.runtime, { ...mcpLimits, maxSessions: 2 }),
    /capacity differs/,
  );
  for (const id of ["", "a".repeat(129), null, 1])
    assert.throws(() => mcpSessionKey(id as string), /Invalid native/);
  for (const text of ["null", "[]", "bad", '{"sequence":"wrong"}'])
    assert.throws(() => parseMcpSessionState(text), /Invalid native/);
  assert.deepEqual(parseMcpSessionState("{}"), {});
  const id = "nul\u0000lone\ud800";
  const lease = (await f.store.acquire(id))!;
  const state = JSON.stringify({
    sessionId: id,
    pendingUris: ["uri\udc00"],
    sequence: 5,
  });
  await f.store.save(lease, state);
  assert.equal((await row()).state, state);
  assert.equal((await row()).session_key, JSON.stringify(id));
  await assert.rejects(
    f.store.save(lease, JSON.stringify({ sessionId: "other" })),
    /identity differs/,
  );
  await assert.rejects(
    f.store.save(
      lease,
      JSON.stringify({ sessionId: id, padding: "x".repeat(131072) }),
    ),
    /capacity/,
  );
  await db.exec(
    "ALTER TABLE realtime.mcp_sessions DISABLE TRIGGER mcp_state_capacity",
  );
  await assert.rejects(f.store.renew(lease), /enforcement/);
});

test("exclusive leases fence stale writes, renewal and release after takeover", async () => {
  const first = (await f.store.acquire("A"))!;
  const peer = await createPgMcpSessionStore(f.runtime, f.limits);
  assert.equal(await peer.acquire("A"), null);
  const renewed = await f.store.renew(first);
  assert.ok(renewed.expiresAtMs > renewed.nowMs);
  await db.exec("UPDATE realtime.mcp_sessions SET lease_until_ms=0");
  const second = (await peer.acquire("A"))!;
  assert.notEqual(second.token, first.token);
  await assert.rejects(f.store.save(first, "{}"), /ownership/);
  await assert.rejects(f.store.renew(first), /ownership/);
  await f.store.release(first);
  assert.equal((await row()).owner_token, second.token);
  await peer.save(second, JSON.stringify({ sessionId: "A", sequence: 7 }));
  await peer.release(second);
  const restored = (await f.store.acquire("A"))!;
  assert.equal(parseMcpSessionState(restored.state).sequence, 7);
});

test("database capacity is atomic and empty sessions can be removed without deleting known state", async () => {
  f = await mcpFixture(db, { ...mcpLimits, maxSessions: 1 });
  const first = (await f.store.acquire("A"))!;
  await assert.rejects(f.store.acquire("B"));
  assert.equal(await f.store.dropEmpty(first), true);
  const second = (await f.store.acquire("B"))!;
  await f.store.save(second, JSON.stringify({ sessionId: "B" }));
  assert.equal(await f.store.dropEmpty(second), false);
  await assert.rejects(
    db.exec("UPDATE realtime.mcp_sessions SET session_key='\"changed\"'"),
    /identity/,
  );
  const capacity = (
    await db.query<{ session_count: number; state_bytes: string }>(
      "SELECT session_count,state_bytes FROM realtime.mcp_capacity",
    )
  ).rows[0]!;
  assert.equal(capacity.session_count, 1);
  assert.equal(
    Number(capacity.state_bytes),
    Buffer.byteLength(JSON.stringify({ sessionId: "B" })),
  );
});

test("alarm claims retain re-arms and reject stale completion after takeover", async () => {
  const lease = (await f.store.acquire("A"))!;
  for (const value of [-1, NaN, 0.5, Infinity])
    await assert.rejects(f.store.setAlarm(lease, value), /alarm time/);
  for (const value of [0, 101, 0.5])
    await assert.rejects(f.store.due(value), /batch limit/);
  assert.equal(await f.store.claimAlarm(lease), null);
  await f.store.setAlarm(lease, 0);
  assert.deepEqual(await f.store.due(10), ["A"]);
  const claim = (await f.store.claimAlarm(lease))!;
  assert.equal(await f.store.claimAlarm(lease), null);
  assert.deepEqual(await f.store.due(10), []);
  await f.store.setAlarm(lease, Date.now() + 60000);
  assert.equal(await f.store.settleAlarm(lease, claim, false), true);
  assert.equal((await row()).alarm_outcome, "pending");
  assert.equal(await f.store.claimAlarm(lease), null);
  await f.store.setAlarm(lease, 0);
  const old = (await f.store.claimAlarm(lease))!;
  await db.exec("UPDATE realtime.mcp_sessions SET lease_until_ms=0");
  const peer = await createPgMcpSessionStore(f.runtime, f.limits);
  const next = (await peer.acquire("A"))!;
  await assert.rejects(f.store.settleAlarm(lease, old, false), /ownership/);
  const reclaimed = (await peer.claimAlarm(next))!;
  assert.notEqual(reclaimed.token, old.token);
  assert.equal(
    await peer.settleAlarm(next, { ...reclaimed, token: old.token }, false),
    false,
  );
  assert.equal(await peer.settleAlarm(next, reclaimed, false), true);
  assert.equal((await row()).alarm_at_ms, null);
});

test("failed alarms retry with bounded exponential delay and then retain exhausted status", async () => {
  const lease = (await f.store.acquire("A"))!;
  await f.store.setAlarm(lease, 0);
  for (let attempt = 1; attempt <= 6; attempt++) {
    const claim = (await f.store.claimAlarm(lease))!;
    assert.ok(claim);
    assert.equal(await f.store.settleAlarm(lease, claim, true), true);
    const saved = await row();
    assert.equal(saved.alarm_attempts, attempt);
    if (attempt < 6) {
      assert.equal(saved.alarm_outcome, "retry");
      assert.ok(
        Number(saved.alarm_at_ms) >=
          Date.now() + 2000 * 2 ** (attempt - 1) - 1000,
      );
      await db.exec("UPDATE realtime.mcp_sessions SET alarm_at_ms=0");
    } else {
      assert.equal(saved.alarm_outcome, "exhausted");
      assert.equal(saved.alarm_at_ms, null);
    }
  }
  await f.store.setAlarm(lease, 0);
  assert.equal((await row()).alarm_attempts, 0);
  await db.exec("UPDATE realtime.mcp_sessions SET alarm_attempts=6");
  assert.equal(await f.store.claimAlarm(lease), null);
  assert.equal((await row()).alarm_outcome, "exhausted");
});

test("corrupted session identity cannot acquire custody or enter the alarm scanner", async () => {
  const lease = (await f.store.acquire("A"))!;
  await f.store.release(lease);
  await db.exec(`UPDATE realtime.mcp_sessions SET state='{"sessionId":"B"}'`);
  await assert.rejects(f.store.acquire("A"), /identity differs/);
  await db.exec(
    "ALTER TABLE realtime.mcp_sessions DROP CONSTRAINT mcp_sessions_session_key_check",
  );
  await db.exec(
    "INSERT INTO realtime.mcp_sessions(session_key,updated_at_ms,alarm_at_ms) VALUES('[]',0,0)",
  );
  await assert.rejects(f.store.due(10), /stored MCP session key/);
});
