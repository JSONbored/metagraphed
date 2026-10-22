import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import {
  AGENT_AUTH_MAX_POLLS,
  AGENT_AUTH_DEFAULT_RESOURCE,
  AGENT_AUTH_MAX_REGISTRATIONS,
  AGENT_AUTH_MAX_CEREMONIES,
  AGENT_AUTH_MAX_TOKENS,
  AGENT_AUTH_MAX_CEREMONIES_PER_REGISTRATION,
  AGENT_AUTH_MAX_TOKENS_PER_REGISTRATION,
  AgentAuthCapacityError,
  createAgentAuthStore,
  type AgentAuthOwner,
} from "../src/agent-auth-store.ts";
import { pruneAgentAuthState } from "../src/agent-auth-prune.ts";
import { createAgentAuthFixture } from "./agent-auth-fixtures.ts";

const fixtures: ReturnType<typeof createAgentAuthFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((f) => f.close()));
function fixture(options?: Parameters<typeof createAgentAuthFixture>[0]) {
  const f = createAgentAuthFixture(options);
  fixtures.push(f);
  return f;
}
const hash = (character: string) => character.repeat(64);
const input = {
  id: "registration-1",
  agentName: "Example agent",
  emailHint: "owner@example.com",
  permissions: ["profile"],
  claimTokenHash: hash("a"),
  userCodeHash: hash("b"),
  createdAt: 100,
  expiresAt: 700,
};
const ceremony = {
  stateHash: hash("c"),
  registrationId: input.id,
  claimVersion: 1,
  cookieHash: hash("d"),
  csrfHash: hash("e"),
  createdAt: 100,
  expiresAt: 600,
};
const owner: AgentAuthOwner = {
  kind: "github",
  id: "42",
  email: input.emailHint,
};
const approval = { ...ceremony, userCodeHash: input.userCodeHash, now: 112 };
async function browser(f: ReturnType<typeof fixture>) {
  await f.store.createRegistration(input);
  await f.store.createCeremony(ceremony);
  assert.ok(await f.store.consumeOAuthState({ ...ceremony, now: 110 }));
  assert.ok(await f.store.finishOAuth({ ...ceremony, owner, now: 111 }));
}
async function approved(f: ReturnType<typeof fixture>) {
  await browser(f);
  const result = await f.store.consumeCeremony(approval);
  assert.ok(result);
  return result;
}
const token = {
  registrationId: input.id,
  issuedAt: 112,
  assertionExpiresAt: 3712,
  tokenHash: hash("f"),
  now: 120,
  expiresAt: 3700,
};
const numberedHash = (value: number) => value.toString(16).padStart(64, "0");
type PrivateTable =
  | "agent_auth_registrations"
  | "agent_auth_ceremonies"
  | "agent_auth_tokens";
function count(f: ReturnType<typeof fixture>, table: PrivateTable) {
  return Number(
    f.sql.prepare(`SELECT count(*) AS total FROM ${table}`).get()!.total,
  );
}
function assertOneAdmission<T>(results: PromiseSettledResult<T>[]) {
  let admitted = -1;
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") {
      assert.ok(result.value);
      assert.equal(admitted, -1);
      admitted = index;
    } else {
      assert.ok(result.reason instanceof AgentAuthCapacityError);
    }
  }
  assert.notEqual(admitted, -1);
  return admitted;
}
function seedRegistrations(f: ReturnType<typeof fixture>, amount: number) {
  f.sql
    .prepare(
      `WITH RECURSIVE sequence(n) AS (
    SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n<?
  ) INSERT INTO agent_auth_registrations
    (id,agent_name,email_hint,permissions,claim_token_hash,user_code_hash,created_at,expires_at)
  SELECT 'admission-registration-'||n,'Example agent','owner@example.com','["profile"]',
    printf('%064x',n),printf('%064x',n+100000),1,10000 FROM sequence`,
    )
    .run(amount);
}
function seedCeremonies(
  f: ReturnType<typeof fixture>,
  parent: string,
  amount: number,
) {
  f.sql
    .prepare(
      `WITH RECURSIVE sequence(n) AS (
    SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n<?
  ) INSERT INTO agent_auth_ceremonies
    (state_hash,registration_id,claim_version,cookie_hash,csrf_hash,created_at,expires_at)
  SELECT printf('%064x',n),?,1,printf('%064x',n+100000),printf('%064x',n+200000),1,10000
  FROM sequence`,
    )
    .run(amount, parent);
}
function seedTokens(
  f: ReturnType<typeof fixture>,
  parent: string,
  amount: number,
) {
  f.sql
    .prepare(
      `WITH RECURSIVE sequence(n) AS (
    SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n<?
  ) INSERT INTO agent_auth_tokens
    (token_hash,registration_id,claim_version,created_at,expires_at)
  SELECT printf('%064x',n),?,1,1,10000 FROM sequence`,
    )
    .run(amount, parent);
}

test("global registration admission is atomic and one pruned row restores one slot", async () => {
  const f = fixture();
  seedRegistrations(f, AGENT_AUTH_MAX_REGISTRATIONS - 1);
  f.sql
    .prepare(
      "UPDATE agent_auth_registrations SET expires_at=2 WHERE id='admission-registration-1'",
    )
    .run();
  const attempts = Array.from({ length: 12 }, (_, index) => ({
    ...input,
    id: `concurrent-registration-${index}`,
    claimTokenHash: numberedHash(1_000_000 + index),
    createdAt: 5000,
    expiresAt: 5600,
  }));
  const winner = assertOneAdmission(
    await Promise.allSettled(
      attempts.map((attempt) => f.store.createRegistration(attempt)),
    ),
  );
  assert.equal(
    count(f, "agent_auth_registrations"),
    AGENT_AUTH_MAX_REGISTRATIONS,
  );
  assert.ok(await f.store.readClaim(attempts[winner]!.claimTokenHash, 5000));
  assert.equal(await f.store.createRegistration(attempts[winner]!), null);
  const next = {
    ...input,
    id: "after-prune",
    claimTokenHash: numberedHash(2_000_000),
    createdAt: 5000,
    expiresAt: 5600,
  };
  await assert.rejects(
    f.store.createRegistration(next),
    AgentAuthCapacityError,
  );
  const pruned = await pruneAgentAuthState(f.db, 5000);
  assert.equal(pruned.status, "pruned");
  assert.equal(
    count(f, "agent_auth_registrations"),
    AGENT_AUTH_MAX_REGISTRATIONS - 1,
  );
  assert.ok(await f.store.createRegistration(next));
  await assert.rejects(
    f.store.createRegistration({
      ...next,
      id: "still-full",
      claimTokenHash: numberedHash(2_000_001),
    }),
    AgentAuthCapacityError,
  );
  assert.ok(await f.store.readClaim(attempts[winner]!.claimTokenHash, 5000));
});

test("global ceremony admission cannot be amplified across registrations", async () => {
  const f = fixture();
  await f.store.createRegistration(input);
  const filler = "ceremony-filler";
  await f.store.createRegistration({
    ...input,
    id: filler,
    claimTokenHash: numberedHash(900_000),
    createdAt: 1,
    expiresAt: 10000,
  });
  seedCeremonies(f, filler, AGENT_AUTH_MAX_CEREMONIES - 1);
  f.sql
    .prepare("UPDATE agent_auth_ceremonies SET expires_at=2 WHERE state_hash=?")
    .run(numberedHash(1));
  const attempts = Array.from({ length: 12 }, (_, index) => ({
    ...ceremony,
    stateHash: numberedHash(1_000_000 + index),
  }));
  const winner = assertOneAdmission(
    await Promise.allSettled(
      attempts.map((attempt) => f.store.createCeremony(attempt)),
    ),
  );
  assert.equal(count(f, "agent_auth_ceremonies"), AGENT_AUTH_MAX_CEREMONIES);
  assert.ok(await f.store.getCeremony({ ...attempts[winner]!, now: 100 }));
  assert.equal(await f.store.createCeremony(attempts[winner]!), null);
  const next = { ...ceremony, stateHash: numberedHash(2_000_000) };
  await assert.rejects(f.store.createCeremony(next), AgentAuthCapacityError);
  assert.equal((await pruneAgentAuthState(f.db, 100)).status, "pruned");
  assert.equal(
    count(f, "agent_auth_ceremonies"),
    AGENT_AUTH_MAX_CEREMONIES - 1,
  );
  assert.ok(await f.store.createCeremony(next));
  await assert.rejects(
    f.store.createCeremony({ ...next, stateHash: numberedHash(2_000_001) }),
    AgentAuthCapacityError,
  );
  assert.ok(await f.store.getCeremony({ ...attempts[winner]!, now: 100 }));
});

test("global token admission preserves existing tokens and resumes after one deletion", async () => {
  const f = fixture();
  await approved(f);
  const filler = "token-filler";
  await f.store.createRegistration({
    ...input,
    id: filler,
    claimTokenHash: numberedHash(900_000),
    createdAt: 1,
    expiresAt: 10000,
  });
  seedTokens(f, filler, AGENT_AUTH_MAX_TOKENS - 1);
  f.sql
    .prepare("UPDATE agent_auth_tokens SET expires_at=2 WHERE token_hash=?")
    .run(numberedHash(1));
  const attempts = Array.from({ length: 12 }, (_, index) => ({
    ...token,
    tokenHash: numberedHash(1_000_000 + index),
  }));
  const winner = assertOneAdmission(
    await Promise.allSettled(
      attempts.map((attempt) => f.store.issueToken(attempt)),
    ),
  );
  assert.equal(count(f, "agent_auth_tokens"), AGENT_AUTH_MAX_TOKENS);
  assert.ok(await f.store.resolveToken(attempts[winner]!.tokenHash, 120));
  assert.equal(await f.store.issueToken(attempts[winner]!), false);
  const next = { ...token, tokenHash: numberedHash(2_000_000) };
  await assert.rejects(f.store.issueToken(next), AgentAuthCapacityError);
  assert.equal((await pruneAgentAuthState(f.db, 120)).status, "pruned");
  assert.equal(count(f, "agent_auth_tokens"), AGENT_AUTH_MAX_TOKENS - 1);
  assert.equal(await f.store.issueToken(next), true);
  await assert.rejects(
    f.store.issueToken({ ...next, tokenHash: numberedHash(2_000_001) }),
    AgentAuthCapacityError,
  );
  assert.ok(await f.store.resolveToken(attempts[winner]!.tokenHash, 120));
});

test("per-registration ceremony admission includes earlier claim versions", async () => {
  const f = fixture();
  await f.store.createRegistration(input);
  for (
    let index = 0;
    index < AGENT_AUTH_MAX_CEREMONIES_PER_REGISTRATION - 1;
    index++
  )
    assert.ok(
      await f.store.createCeremony({
        ...ceremony,
        stateHash: numberedHash(index + 1),
        expiresAt: index === 0 ? 110 : 600,
      }),
    );
  assert.ok(
    await f.store.rotateClaim({
      registrationId: input.id,
      claimTokenHash: input.claimTokenHash,
      nextClaimTokenHash: hash("1"),
      nextUserCodeHash: hash("2"),
      now: 105,
    }),
  );
  const attempts = Array.from({ length: 12 }, (_, index) => ({
    ...ceremony,
    stateHash: numberedHash(1_000_000 + index),
    claimVersion: 2,
    createdAt: 105,
  }));
  const winner = assertOneAdmission(
    await Promise.allSettled(
      attempts.map((attempt) => f.store.createCeremony(attempt)),
    ),
  );
  assert.equal(
    count(f, "agent_auth_ceremonies"),
    AGENT_AUTH_MAX_CEREMONIES_PER_REGISTRATION,
  );
  assert.ok(await f.store.getCeremony({ ...attempts[winner]!, now: 105 }));
  const next = {
    ...attempts[0]!,
    stateHash: numberedHash(2_000_000),
    createdAt: 111,
  };
  await assert.rejects(f.store.createCeremony(next), AgentAuthCapacityError);
  assert.equal(
    await f.store.createCeremony({ ...next, claimVersion: 1 }),
    null,
  );
  assert.equal((await pruneAgentAuthState(f.db, 111)).status, "pruned");
  assert.equal(
    count(f, "agent_auth_ceremonies"),
    AGENT_AUTH_MAX_CEREMONIES_PER_REGISTRATION - 1,
  );
  assert.ok(await f.store.createCeremony(next));
  await assert.rejects(
    f.store.createCeremony({ ...next, stateHash: numberedHash(2_000_001) }),
    AgentAuthCapacityError,
  );
});

test("per-registration token admission includes rotated and expired token rows", async () => {
  const f = fixture();
  await approved(f);
  for (
    let index = 0;
    index < AGENT_AUTH_MAX_TOKENS_PER_REGISTRATION - 1;
    index++
  )
    assert.equal(
      await f.store.issueToken({
        ...token,
        tokenHash: numberedHash(index + 1),
        expiresAt: index === 0 ? 121 : 3700,
      }),
      true,
    );
  assert.ok(
    await f.store.rotateClaim({
      registrationId: input.id,
      claimTokenHash: input.claimTokenHash,
      nextClaimTokenHash: hash("1"),
      nextUserCodeHash: hash("2"),
      now: 120,
    }),
  );
  const attempts = Array.from({ length: 12 }, (_, index) => ({
    ...token,
    tokenHash: numberedHash(1_000_000 + index),
  }));
  const winner = assertOneAdmission(
    await Promise.allSettled(
      attempts.map((attempt) => f.store.issueToken(attempt)),
    ),
  );
  assert.equal(
    count(f, "agent_auth_tokens"),
    AGENT_AUTH_MAX_TOKENS_PER_REGISTRATION,
  );
  assert.ok(await f.store.resolveToken(attempts[winner]!.tokenHash, 120));
  const next = { ...token, tokenHash: numberedHash(2_000_000), now: 121 };
  await assert.rejects(f.store.issueToken(next), AgentAuthCapacityError);
  assert.equal(await f.store.issueToken({ ...next, issuedAt: 113 }), false);
  assert.equal((await pruneAgentAuthState(f.db, 121)).status, "pruned");
  assert.equal(
    count(f, "agent_auth_tokens"),
    AGENT_AUTH_MAX_TOKENS_PER_REGISTRATION - 1,
  );
  assert.equal(await f.store.issueToken(next), true);
  await assert.rejects(
    f.store.issueToken({ ...next, tokenHash: numberedHash(2_000_001) }),
    AgentAuthCapacityError,
  );
  assert.ok(await f.store.resolveToken(attempts[winner]!.tokenHash, 121));
});

test("capacity refusal stays retryable when a deletion races its classification", async () => {
  const f = fixture();
  await f.store.createRegistration(input);
  for (
    let index = 0;
    index < AGENT_AUTH_MAX_CEREMONIES_PER_REGISTRATION;
    index++
  )
    assert.ok(
      await f.store.createCeremony({
        ...ceremony,
        stateHash: numberedHash(index + 1),
        expiresAt: index === 0 ? 110 : 600,
      }),
    );
  const next = {
    ...ceremony,
    stateHash: numberedHash(2_000_000),
    createdAt: 111,
  };
  let deleted = false;
  f.before((query) => {
    if (!query.includes("SELECT 1 AS present FROM agent_auth_registrations r"))
      return;
    f.before();
    f.sql
      .prepare(
        "DELETE FROM agent_auth_ceremonies WHERE state_hash=? AND expires_at<=111",
      )
      .run(numberedHash(1));
    deleted = true;
  });
  await assert.rejects(f.store.createCeremony(next), AgentAuthCapacityError);
  assert.equal(deleted, true);
  assert.equal(
    count(f, "agent_auth_ceremonies"),
    AGENT_AUTH_MAX_CEREMONIES_PER_REGISTRATION - 1,
  );
  assert.ok(await f.store.createCeremony(next));
  assert.equal(
    count(f, "agent_auth_ceremonies"),
    AGENT_AUTH_MAX_CEREMONIES_PER_REGISTRATION,
  );
});

test("readiness checks native primary schema, including every private table", async () => {
  assert.equal(createAgentAuthStore(undefined), null);
  const f = fixture();
  assert.deepEqual(f.sessions, ["first-primary"]);
  assert.equal(await f.store.ready(), true);
  assert.equal(await fixture({ session: false }).store.ready(), true);
  assert.equal(await fixture({ migrated: false }).store.ready(), false);
  f.sql.exec(
    "ALTER TABLE agent_auth_tokens RENAME COLUMN expires_at TO broken",
  );
  assert.equal(await f.store.ready(), false);
  const withoutResource = fixture();
  withoutResource.sql.exec(
    "ALTER TABLE agent_auth_tokens RENAME COLUMN resource TO broken",
  );
  assert.equal(await withoutResource.store.ready(), false);
});

test("registration normalizes immutable email and stores only supplied hashes", async () => {
  const f = fixture();
  const result = await f.store.createRegistration({
    ...input,
    emailHint: " Owner@Example.COM ",
  });
  assert.equal(result?.emailHint, input.emailHint);
  assert.deepEqual(result?.permissions, ["profile"]);
  assert.equal(result?.approvedAt, null);
  assert.deepEqual(await f.store.getRegistration(input.id), result);
  assert.equal(await f.store.getRegistration("missing"), null);
  assert.equal(
    await f.store.createRegistration({
      ...input,
      emailHint: "attacker@example.com",
    }),
    null,
  );
  assert.equal(
    (await f.store.getRegistration(input.id))?.emailHint,
    input.emailHint,
  );
  const stored = f.sql
    .prepare(
      "SELECT claim_token_hash,user_code_hash FROM agent_auth_registrations",
    )
    .get();
  assert.equal(stored?.claim_token_hash, input.claimTokenHash);
  assert.equal(stored?.user_code_hash, input.userCodeHash);
  assert.ok(await f.store.readClaim(input.claimTokenHash, 100));
  assert.equal(await f.store.readClaim(input.claimTokenHash, 99), null);
  assert.equal(await f.store.readClaim(input.claimTokenHash, 700), null);
  assert.equal(await f.store.readClaim(hash("0"), 100), null);
});

test("corrupt stored permissions cannot become registration or token authority", async () => {
  const pending = fixture();
  await pending.store.createRegistration(input);
  const active = fixture();
  await approved(active);
  assert.equal(await active.store.issueToken(token), true);
  // Simulate legacy or corrupted state that the current SQL constraint rejects.
  pending.sql.exec("PRAGMA ignore_check_constraints=ON");
  active.sql.exec("PRAGMA ignore_check_constraints=ON");
  let now = 120;
  for (const permissions of [
    "{",
    "null",
    "[]",
    '["admin"]',
    '["profile","admin"]',
    '["profile",1]',
    '["profile" ]',
  ]) {
    for (const f of [pending, active]) {
      f.sql
        .prepare("UPDATE agent_auth_registrations SET permissions=?")
        .run(permissions);
      assert.equal(await f.store.getRegistration(input.id), null);
      assert.deepEqual(await f.store.pollClaim(input.claimTokenHash, now), {
        status: "missing",
      });
    }
    assert.equal(
      await pending.store.readClaim(input.claimTokenHash, now),
      null,
    );
    assert.equal(await active.store.resolveToken(token.tokenHash, now), null);
    now += 5;
  }
  active.sql
    .prepare("UPDATE agent_auth_registrations SET permissions=?")
    .run('["profile"]');
  assert.deepEqual(
    (await active.store.resolveToken(token.tokenHash, now))?.permissions,
    ["profile"],
  );
});

test("no token can be issued before verified owner approval", async () => {
  const f = fixture();
  await f.store.createRegistration(input);
  assert.equal(await f.store.issueToken(token), false);
  assert.equal(await f.store.resolveToken(token.tokenHash, 120), null);
  assert.equal(await f.store.consumeCeremony(approval), null);
  assert.equal(
    await f.store.revokeRegistration({
      registrationId: input.id,
      ownerId: owner.id,
      now: 120,
    }),
    false,
  );
});

test("OAuth state and browser ceremony require current cookie, version and expiry", async () => {
  const f = fixture();
  await f.store.createRegistration(input);
  assert.equal(
    await f.store.createCeremony({ ...ceremony, registrationId: "missing" }),
    null,
  );
  assert.equal(
    await f.store.createCeremony({ ...ceremony, expiresAt: 701 }),
    null,
  );
  assert.equal(
    await f.store.createCeremony({ ...ceremony, expiresAt: 100 }),
    null,
  );
  assert.equal(
    await f.store.createCeremony({ ...ceremony, claimVersion: 2 }),
    null,
  );
  assert.ok(await f.store.createCeremony(ceremony));
  assert.equal(await f.store.createCeremony(ceremony), null);
  assert.ok(await f.store.getCeremony({ ...ceremony, now: 100 }));
  assert.equal(
    await f.store.getCeremony({ ...ceremony, cookieHash: hash("0"), now: 100 }),
    null,
  );
  assert.equal(await f.store.getCeremony({ ...ceremony, now: 600 }), null);
  assert.equal(
    await f.store.consumeOAuthState({
      ...ceremony,
      cookieHash: hash("0"),
      now: 100,
    }),
    null,
  );
  assert.ok(await f.store.consumeOAuthState({ ...ceremony, now: 110 }));
  assert.equal(
    await f.store.consumeOAuthState({ ...ceremony, now: 110 }),
    null,
  );
  assert.equal(
    await f.store.finishOAuth({
      ...ceremony,
      owner: { ...owner, email: "wrong@example.com" },
      now: 111,
    }),
    null,
  );
  assert.equal(
    await f.store.finishOAuth({
      ...ceremony,
      owner: { ...owner, id: "999" },
      now: 111,
    }),
    null,
  );
  assert.ok(
    await f.store.finishOAuth({
      ...ceremony,
      owner: { ...owner, email: "OWNER@EXAMPLE.COM" },
      now: 111,
    }),
  );
  assert.equal(
    await f.store.finishOAuth({ ...ceremony, owner, now: 111 }),
    null,
  );
  assert.equal((await f.store.getRegistration(input.id))?.approvedAt, null);
});

test("approval requires final user code and CSRF after OAuth, with five bounded attempts", async () => {
  const f = fixture();
  await browser(f);
  assert.equal(
    await f.store.consumeCeremony({ ...approval, cookieHash: hash("0") }),
    null,
  );
  assert.equal(
    await f.store.consumeCeremony({ ...approval, csrfHash: hash("0") }),
    null,
  );
  for (let i = 0; i < 4; i++)
    assert.equal(
      await f.store.consumeCeremony({ ...approval, userCodeHash: hash("0") }),
      null,
    );
  assert.equal(await f.store.consumeCeremony(approval), null);
  assert.equal((await f.store.getRegistration(input.id))?.approvedAt, null);
  assert.equal(
    f.sql.prepare("SELECT attempts FROM agent_auth_ceremonies").get()?.attempts,
    5,
  );
});

test("concurrent approval has one winner and replay cannot renew authority", async () => {
  const f = fixture();
  await browser(f);
  const results = await Promise.all(
    Array.from({ length: 12 }, () => f.store.consumeCeremony(approval)),
  );
  assert.equal(results.filter(Boolean).length, 1);
  const registered = await f.store.getRegistration(input.id);
  assert.equal(registered?.approvedAt, 112);
  assert.equal(registered?.ownerKind, "github");
  assert.equal(registered?.ownerId, "42");
  assert.equal(registered?.ownerEmail, input.emailHint);
  assert.equal(await f.store.consumeCeremony({ ...approval, now: 120 }), null);
  assert.equal((await f.store.getRegistration(input.id))?.approvedAt, 112);
  assert.equal(await f.store.getCeremony({ ...ceremony, now: 120 }), null);
  assert.equal(await f.store.readClaim(input.claimTokenHash, 120), null);
});

test("the approval batch rolls back consumed state if approval write fails", async () => {
  const f = fixture();
  await browser(f);
  f.before((query) => {
    if (query.includes("SET approved_at="))
      throw new Error("write unavailable");
  });
  await assert.rejects(f.store.consumeCeremony(approval), /write unavailable/);
  f.before();
  assert.equal(
    f.sql.prepare("SELECT attempts FROM agent_auth_ceremonies").get()?.attempts,
    0,
  );
  assert.ok(await f.store.consumeCeremony(approval));
});

test("claim refresh invalidates all old browser states and preserves intended email", async () => {
  const f = fixture();
  await browser(f);
  assert.equal(
    await f.store.rotateClaim({
      ...input,
      registrationId: input.id,
      claimTokenHash: hash("0"),
      nextClaimTokenHash: hash("1"),
      nextUserCodeHash: hash("2"),
      now: 112,
    }),
    null,
  );
  const rotated = await f.store.rotateClaim({
    registrationId: input.id,
    claimTokenHash: input.claimTokenHash,
    nextClaimTokenHash: hash("1"),
    nextUserCodeHash: hash("2"),
    now: 112,
  });
  assert.equal(rotated?.claimVersion, 2);
  assert.equal(rotated?.emailHint, input.emailHint);
  assert.equal(await f.store.consumeCeremony(approval), null);
  assert.equal(await f.store.getCeremony({ ...ceremony, now: 112 }), null);
  assert.equal(
    await f.store.consumeOAuthState({ ...ceremony, now: 112 }),
    null,
  );
  assert.equal(
    await f.store.finishOAuth({ ...ceremony, owner, now: 112 }),
    null,
  );
  assert.deepEqual(await f.store.pollClaim(input.claimTokenHash, 112), {
    status: "missing",
  });
  assert.equal((await f.store.pollClaim(hash("1"), 112)).status, "pending");
});

test("claim refresh with the same bearer replaces the user code and browser version", async () => {
  const f = fixture();
  await f.store.createRegistration(input);
  assert.ok(
    await f.store.rotateClaim({
      registrationId: input.id,
      claimTokenHash: input.claimTokenHash,
      nextClaimTokenHash: input.claimTokenHash,
      nextUserCodeHash: hash("2"),
      now: 112,
    }),
  );
  assert.equal(await f.store.createCeremony(ceremony), null);
  assert.ok(await f.store.createCeremony({ ...ceremony, claimVersion: 2 }));
  await f.store.consumeOAuthState({ ...ceremony, now: 113 });
  await f.store.finishOAuth({ ...ceremony, owner, now: 114 });
  assert.equal(await f.store.consumeCeremony({ ...approval, now: 115 }), null);
  assert.ok(
    await f.store.consumeCeremony({
      ...approval,
      userCodeHash: hash("2"),
      now: 116,
    }),
  );
});

test("polls atomically enforce cadence, expiry and attempt limits", async () => {
  const f = fixture();
  await f.store.createRegistration(input);
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      f.store.pollClaim(input.claimTokenHash, 100),
    ),
  );
  assert.equal(
    results.filter((result) => result.status === "pending").length,
    1,
  );
  assert.equal(
    results.filter((result) => result.status === "rate_limited").length,
    7,
  );
  assert.deepEqual(await f.store.pollClaim(input.claimTokenHash, 104), {
    status: "rate_limited",
    retryAfter: 1,
  });
  assert.equal(
    (await f.store.pollClaim(input.claimTokenHash, 105)).status,
    "pending",
  );
  assert.deepEqual(await f.store.pollClaim(hash("0"), 105), {
    status: "missing",
  });
  f.sql
    .prepare("UPDATE agent_auth_registrations SET poll_count=?,next_poll_at=0")
    .run(AGENT_AUTH_MAX_POLLS - 1);
  assert.equal(
    (await f.store.pollClaim(input.claimTokenHash, 110)).status,
    "pending",
  );
  assert.deepEqual(await f.store.pollClaim(input.claimTokenHash, 115), {
    status: "expired",
  });
  f.sql.prepare("UPDATE agent_auth_registrations SET poll_count=0").run();
  assert.deepEqual(await f.store.pollClaim(input.claimTokenHash, 700), {
    status: "expired",
  });
});

test("every approved poll uses the original one-hour assertion horizon", async () => {
  const f = fixture();
  const registered = await approved(f);
  const result = {
    status: "approved",
    registration: registered,
    issuedAt: 112,
    assertionExpiresAt: 3712,
  };
  assert.deepEqual(await f.store.pollClaim(input.claimTokenHash, 112), result);
  assert.deepEqual(await f.store.pollClaim(input.claimTokenHash, 117), result);
  assert.deepEqual(await f.store.pollClaim(input.claimTokenHash, 3712), {
    status: "expired",
  });
});

test("token issuance is conditional on active approval and exact assertion horizon", async () => {
  const f = fixture();
  await approved(f);
  for (const changed of [
    { registrationId: "missing" },
    { issuedAt: 113 },
    { assertionExpiresAt: 3713 },
    { now: 111 },
    { now: 3712, expiresAt: 3713 },
    { expiresAt: 120 },
    { expiresAt: 3713 },
    { expiresAt: 4000 },
  ])
    assert.equal(await f.store.issueToken({ ...token, ...changed }), false);
  const results = await Promise.all(
    Array.from({ length: 8 }, () => f.store.issueToken(token)),
  );
  assert.equal(results.filter(Boolean).length, 1);
  const resolved = await f.store.resolveToken(token.tokenHash, 120);
  assert.equal(resolved?.id, input.id);
  assert.equal(resolved?.tokenExpiresAt, token.expiresAt);
  assert.equal(resolved?.resource, AGENT_AUTH_DEFAULT_RESOURCE);
  assert.equal(resolved?.ownerKind, "github");
  assert.equal(await f.store.resolveToken(token.tokenHash, 119), null);
  assert.equal(await f.store.resolveToken(token.tokenHash, 3700), null);
  assert.equal(await f.store.resolveToken(hash("0"), 120), null);
});

test("owner-qualified revocation invalidates tokens and cannot race issuance", async () => {
  const f = fixture();
  await approved(f);
  await f.store.issueToken(token);
  assert.equal(
    await f.store.revokeRegistration({
      registrationId: input.id,
      ownerId: "4200",
      now: 121,
    }),
    false,
  );
  assert.ok(await f.store.resolveToken(token.tokenHash, 121));
  assert.equal(
    await f.store.revokeRegistration({
      registrationId: input.id,
      ownerId: owner.id,
      now: 121,
    }),
    true,
  );
  assert.equal(await f.store.resolveToken(token.tokenHash, 121), null);
  assert.equal(
    await f.store.issueToken({ ...token, tokenHash: hash("0"), now: 122 }),
    false,
  );
  assert.deepEqual(await f.store.pollClaim(input.claimTokenHash, 122), {
    status: "revoked",
  });
  assert.equal(
    await f.store.revokeRegistration({
      registrationId: input.id,
      ownerId: owner.id,
      now: 122,
    }),
    false,
  );
  assert.equal(
    await f.store.rotateClaim({
      registrationId: input.id,
      claimTokenHash: input.claimTokenHash,
      nextClaimTokenHash: hash("1"),
      nextUserCodeHash: hash("2"),
      now: 122,
    }),
    null,
  );
});

test("deleting the qualified GitHub owner immediately invalidates all credentials", async () => {
  const f = fixture();
  await approved(f);
  await f.store.issueToken(token);
  f.sql.exec("DELETE FROM github_accounts WHERE id=42");
  assert.equal(await f.store.resolveToken(token.tokenHash, 121), null);
  assert.equal(
    await f.store.issueToken({ ...token, tokenHash: hash("0"), now: 121 }),
    false,
  );
  assert.equal(
    await f.store.revokeRegistration({
      registrationId: input.id,
      ownerId: owner.id,
      now: 121,
    }),
    false,
  );
});

test("token revocation is idempotent and leaves sibling tokens and registration active", async () => {
  const f = fixture();
  await approved(f);
  assert.equal(await f.store.issueToken(token), true);
  assert.equal(
    await f.store.issueToken({ ...token, tokenHash: hash("0") }),
    true,
  );
  await Promise.all(
    Array.from({ length: 8 }, () => f.store.revokeToken(token.tokenHash)),
  );
  await f.store.revokeToken(hash("1"));
  assert.equal(await f.store.resolveToken(token.tokenHash, 121), null);
  assert.ok(await f.store.resolveToken(hash("0"), 121));
  assert.equal((await f.store.getRegistration(input.id))?.revokedAt, null);
  assert.equal(
    (await f.store.pollClaim(input.claimTokenHash, 121)).status,
    "approved",
  );
});

test("expired browser states and removed owners cannot approve a registration", async () => {
  const f = fixture();
  await browser(f);
  assert.equal(await f.store.consumeCeremony({ ...approval, now: 600 }), null);
  f.sql.exec("DELETE FROM github_accounts WHERE id=42");
  assert.equal(await f.store.consumeCeremony(approval), null);
  assert.equal((await f.store.getRegistration(input.id))?.approvedAt, null);
});

test("approved claim rotation retains the fixed horizon and invalidates existing tokens", async () => {
  const f = fixture();
  await approved(f);
  await f.store.issueToken(token);
  const next = await f.store.rotateClaim({
    registrationId: input.id,
    claimTokenHash: input.claimTokenHash,
    nextClaimTokenHash: hash("1"),
    nextUserCodeHash: hash("2"),
    now: 121,
  });
  assert.equal(next?.approvedAt, 112);
  assert.equal(await f.store.resolveToken(token.tokenHash, 122), null);
  const poll = await f.store.pollClaim(hash("1"), 122);
  assert.equal(poll.status, "approved");
  if (poll.status === "approved") assert.equal(poll.assertionExpiresAt, 3712);
  assert.equal(
    await f.store.rotateClaim({
      registrationId: input.id,
      claimTokenHash: hash("1"),
      nextClaimTokenHash: hash("3"),
      nextUserCodeHash: hash("4"),
      now: 3712,
    }),
    null,
  );
});

test("tokens retain one canonical MCP resource and reject invalid resources", async () => {
  const f = fixture();
  await approved(f);
  for (const resource of [
    "",
    "/mcp",
    "https://api.metagraph.sh/mcp/",
    "https://api.metagraph.sh/mcp?other=1",
    "https://api.metagraph.sh/mcp/core#fragment",
    "https://api.metagraph.sh/mcp/other",
    "https://other.example/mcp",
  ]) {
    assert.equal(await f.store.issueToken({ ...token, resource }), false);
  }
  const resource = "https://api.metagraph.sh/mcp/core";
  assert.equal(await f.store.issueToken({ ...token, resource }), true);
  assert.equal(
    (await f.store.resolveToken(token.tokenHash, 120))?.resource,
    resource,
  );
  assert.equal(
    f.sql.prepare("SELECT resource FROM agent_auth_tokens").get()?.resource,
    resource,
  );
});
