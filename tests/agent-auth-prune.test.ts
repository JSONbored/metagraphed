import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import {
  AGENT_AUTH_PRUNE_MAX_CHILDREN,
  AGENT_AUTH_PRUNE_MAX_REGISTRATIONS,
  pruneAgentAuthState,
} from "../src/agent-auth-prune.ts";
import { createAgentAuthFixture } from "./agent-auth-fixtures.ts";

const NOW = 10_000;
const fixtures: ReturnType<typeof createAgentAuthFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((f) => f.close()));
function fixture(options?: Parameters<typeof createAgentAuthFixture>[0]) {
  const f = createAgentAuthFixture(options);
  fixtures.push(f);
  return f;
}
type Fixture = ReturnType<typeof fixture>;
const hash = (value: number) => value.toString(16).padStart(64, "0");

function registration(
  f: Fixture,
  id: number,
  expiresAt = 6000,
  approvedAt: number | null = null,
) {
  const registrationId = `registration-${id}`;
  f.sql
    .prepare(
      `INSERT INTO agent_auth_registrations
        (id,agent_name,email_hint,permissions,claim_token_hash,user_code_hash,
         created_at,expires_at,approved_at,owner_kind,owner_id,owner_email)
      VALUES (?,'Example agent','owner@example.com','["profile"]',?,?,1,?,?,?,?,?)`,
    )
    .run(
      registrationId,
      hash(id),
      hash(id + 100_000),
      expiresAt,
      approvedAt,
      approvedAt === null ? null : "github",
      approvedAt === null ? null : "42",
      approvedAt === null ? null : "owner@example.com",
    );
  return registrationId;
}
function token(f: Fixture, id: number, parent: string, expiresAt = NOW) {
  f.sql
    .prepare(
      `INSERT INTO agent_auth_tokens
        (token_hash,registration_id,claim_version,created_at,expires_at)
      VALUES (?,?,1,1,?)`,
    )
    .run(hash(id), parent, expiresAt);
}
function ceremony(f: Fixture, id: number, parent: string, expiresAt = NOW) {
  f.sql
    .prepare(
      `INSERT INTO agent_auth_ceremonies
        (state_hash,registration_id,claim_version,cookie_hash,csrf_hash,created_at,expires_at)
      VALUES (?,?,1,?,?,1,?)`,
    )
    .run(hash(id), parent, hash(id + 100_000), hash(id + 200_000), expiresAt);
}
function count(f: Fixture, table: string): number {
  return f.sql.prepare(`SELECT count(*) AS count FROM ${table}`).get()!
    .count as number;
}

test("expires children before their parent in one primary batch and is idempotent", async () => {
  const f = fixture();
  const parent = registration(f, 1, 6000, 5900);
  token(f, 1, parent);
  ceremony(f, 1, parent);
  f.sessions.length = 0;
  const queries: string[] = [];
  f.before((query) => queries.push(query));
  assert.deepEqual(await pruneAgentAuthState(f.db, NOW), {
    status: "pruned",
    deleted: { tokens: 1, ceremonies: 1, registrations: 1 },
  });
  assert.deepEqual(f.sessions, ["first-primary"]);
  assert.equal(queries.length, 3);
  assert.match(queries[0], /^DELETE FROM agent_auth_tokens/);
  assert.match(queries[1], /^DELETE FROM agent_auth_ceremonies/);
  assert.match(queries[2], /^DELETE FROM agent_auth_registrations/);
  assert.equal(count(f, "agent_auth_registrations"), 0);
  assert.deepEqual(await pruneAgentAuthState(f.db, NOW), {
    status: "pruned",
    deleted: { tokens: 0, ceremonies: 0, registrations: 0 },
  });
});

test("preserves active credentials, pending claims and the full assertion horizon", async () => {
  const f = fixture({ session: false });
  registration(f, 1, 6400, 6399);
  registration(f, 2, 6402, 6401);
  registration(f, 3, NOW + 1);
  const activeToken = registration(f, 4);
  const activeCeremony = registration(f, 5);
  token(f, 1, activeToken, NOW + 1);
  ceremony(f, 1, activeCeremony, NOW + 1);
  assert.deepEqual(await pruneAgentAuthState(f.db, NOW), {
    status: "pruned",
    deleted: { tokens: 0, ceremonies: 0, registrations: 1 },
  });
  assert.deepEqual(
    f.sql
      .prepare("SELECT id FROM agent_auth_registrations ORDER BY id")
      .all()
      .map((row) => row.id),
    ["registration-2", "registration-3", "registration-4", "registration-5"],
  );
  assert.equal(count(f, "agent_auth_tokens"), 1);
  assert.equal(count(f, "agent_auth_ceremonies"), 1);
});

test("a child backlog stops at the batch bound and keeps its parent until drained", async () => {
  const f = fixture();
  const parent = registration(f, 1);
  f.sql.exec("BEGIN");
  for (let id = 1; id <= AGENT_AUTH_PRUNE_MAX_CHILDREN + 1; id++) {
    token(f, id, parent);
    ceremony(f, id, parent);
  }
  f.sql.exec("COMMIT");
  assert.deepEqual(await pruneAgentAuthState(f.db, NOW), {
    status: "pruned",
    deleted: {
      tokens: AGENT_AUTH_PRUNE_MAX_CHILDREN,
      ceremonies: AGENT_AUTH_PRUNE_MAX_CHILDREN,
      registrations: 0,
    },
  });
  assert.equal(count(f, "agent_auth_tokens"), 1);
  assert.equal(count(f, "agent_auth_ceremonies"), 1);
  assert.equal(count(f, "agent_auth_registrations"), 1);
  assert.deepEqual(await pruneAgentAuthState(f.db, NOW), {
    status: "pruned",
    deleted: { tokens: 1, ceremonies: 1, registrations: 1 },
  });
});

test("registration candidates stop at the batch bound and resume on the next tick", async () => {
  const f = fixture();
  for (let id = 1; id <= AGENT_AUTH_PRUNE_MAX_REGISTRATIONS + 1; id++)
    registration(f, id);
  assert.deepEqual(await pruneAgentAuthState(f.db, NOW), {
    status: "pruned",
    deleted: {
      tokens: 0,
      ceremonies: 0,
      registrations: AGENT_AUTH_PRUNE_MAX_REGISTRATIONS,
    },
  });
  assert.equal(count(f, "agent_auth_registrations"), 1);
  assert.deepEqual(await pruneAgentAuthState(f.db, NOW), {
    status: "pruned",
    deleted: { tokens: 0, ceremonies: 0, registrations: 1 },
  });
});

test("a later statement failure rolls back preceding child deletes", async () => {
  const f = fixture();
  const parent = registration(f, 1);
  token(f, 1, parent);
  ceremony(f, 1, parent);
  f.before((query) => {
    if (query.startsWith("DELETE FROM agent_auth_ceremonies"))
      throw new Error("database unavailable");
  });
  assert.deepEqual(await pruneAgentAuthState(f.db, NOW), {
    status: "unavailable",
  });
  assert.equal(count(f, "agent_auth_tokens"), 1);
  assert.equal(count(f, "agent_auth_ceremonies"), 1);
  assert.equal(count(f, "agent_auth_registrations"), 1);
});

test("missing bindings, invalid time, absent migration and malformed bindings are explicit", async () => {
  assert.deepEqual(await pruneAgentAuthState(undefined, NOW), {
    status: "not-configured",
  });
  const f = fixture();
  for (const now of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(await pruneAgentAuthState(f.db, now), {
      status: "invalid-time",
    });
  }
  assert.deepEqual(
    await pruneAgentAuthState(fixture({ migrated: false }).db, NOW),
    { status: "unavailable" },
  );
  for (const db of [
    null,
    {},
    { withSession: () => null },
    {
      withSession() {
        throw new Error("binding unavailable");
      },
    },
  ]) {
    assert.deepEqual(
      await pruneAgentAuthState(db as unknown as D1Database, NOW),
      { status: "unavailable" },
    );
  }
});

function resultBinding(results: unknown): D1Database {
  return {
    prepare: () => ({ bind: () => ({}) }),
    batch: async () => results,
  } as unknown as D1Database;
}
const empty = () => ({ success: true, results: [] });

test("malformed D1 batch results cannot claim a successful prune", async () => {
  for (const results of [
    null,
    {},
    [],
    [empty()],
    [empty(), empty(), empty(), empty()],
  ]) {
    assert.deepEqual(await pruneAgentAuthState(resultBinding(results), NOW), {
      status: "unavailable",
    });
  }
  for (const result of [
    null,
    false,
    { success: false, results: [] },
    { success: true },
    { success: true, results: {} },
    {
      success: true,
      results: Array.from(
        { length: AGENT_AUTH_PRUNE_MAX_CHILDREN + 1 },
        () => ({ deleted: 1 }),
      ),
    },
    { success: true, results: [null] },
    { success: true, results: [1] },
    { success: true, results: [{}] },
    { success: true, results: [{ deleted: "1" }] },
  ]) {
    assert.deepEqual(
      await pruneAgentAuthState(resultBinding([result, empty(), empty()]), NOW),
      { status: "unavailable" },
    );
  }
  assert.deepEqual(
    await pruneAgentAuthState(resultBinding([empty(), null, empty()]), NOW),
    { status: "unavailable" },
  );
  assert.deepEqual(
    await pruneAgentAuthState(resultBinding([empty(), empty(), null]), NOW),
    { status: "unavailable" },
  );
  assert.deepEqual(
    await pruneAgentAuthState(
      resultBinding([
        empty(),
        empty(),
        {
          success: true,
          results: Array.from(
            { length: AGENT_AUTH_PRUNE_MAX_REGISTRATIONS + 1 },
            () => ({ deleted: 1 }),
          ),
        },
      ]),
      NOW,
    ),
    { status: "unavailable" },
  );
});
