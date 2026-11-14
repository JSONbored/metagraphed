import assert from "node:assert/strict";
import {
  V2AccountStakeCursorSchema,
  V2AccountStakeSchema,
  V2RootEntitlementSchema,
  V2StakePositionSchema,
} from "../../schemas-src/v2/stake.ts";
import {
  MODERN_FIXTURE,
  modernAccountStakeRow,
  modernVerificationFixture,
} from "../../scripts/lib/modern-verification-fixture.ts";
import {
  createV2Operations,
  V2OperationError,
} from "../../src/v2/operations.ts";
import { createV2Handler } from "../../src/v2/api.ts";
import { createV2ReadClient, V2ReadClientError } from "../../src/v2/client.ts";
import {
  accountStakeKey,
  compareAccountStakeKeys,
  decodeAccountStakeCursor,
  encodeAccountStakeCursor,
} from "../../src/v2/account-stake-cursor.ts";

const hash = (digit: string): `0x${string}` => `0x${digit.repeat(64)}`;
const input = { network: "finney", account_id: hash("a"), limit: 1 };
const clock = () => new Date(MODERN_FIXTURE.now);
type Row = ReturnType<typeof modernAccountStakeRow>;
function position(row: Row) {
  const entry = row.entries.find((entry) => entry.kind === "position");
  assert.ok(entry?.kind === "position");
  return entry.position;
}
function entitlement(row: Row) {
  const entry = row.entries.find((entry) => entry.kind === "root_entitlement");
  assert.ok(entry?.kind === "root_entitlement");
  return entry.entitlement;
}
function changed(change: (row: Row) => void, now = clock) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    operations: createV2Operations(
      {
        async query() {
          calls++;
          const row = modernAccountStakeRow();
          change(row);
          return { rows: [row] };
        },
      },
      { now },
    ),
  };
}
function unavailable(error: unknown) {
  return error instanceof V2OperationError && error.code === "data_unavailable";
}

export function registerAccountStakeChecks(
  test: (name: string, check: () => void | Promise<void>) => void,
) {
  test("stake DTO preserves exact zero absent retired and residual asset positions", () => {
    const row = modernAccountStakeRow();
    const current = position(row);
    assert.equal(V2StakePositionSchema.parse(current).quote.status, "exact");
    const zero = structuredClone(current);
    zero.assessment.share_state = "zero";
    zero.assessment.member = {
      encoding: "safe_float_v2",
      mantissa: "0",
      exponent: "0",
    };
    zero.observations.v2_member = {
      status: "stored",
      scale_hex: "0x" + "00".repeat(24),
    };
    zero.quote = {
      status: "exact",
      basis: { kind: "root_tao" },
      atomic_units: "0",
    };
    assert.equal(
      V2StakePositionSchema.parse(zero).assessment.share_state,
      "zero",
    );
    const absent = structuredClone(current);
    absent.assessment.share_state = "absent";
    absent.assessment.member = null;
    absent.selection.member = "absent";
    absent.observations.v2_member = { status: "absent_in_complete_census" };
    absent.quote = { status: "no_current_position", state: "absent" };
    assert.equal(
      V2StakePositionSchema.parse(absent).quote.status,
      "no_current_position",
    );
    const retired = row.entries.at(-1);
    assert.ok(retired?.kind === "position");
    assert.deepEqual(V2StakePositionSchema.parse(retired.position).quote, {
      status: "no_current_position",
      state: "retired",
    });
    const residual = structuredClone(current);
    Object.assign(residual, {
      netuid: 7,
      subnet: { status: "residual_storage", generation: null },
      asset: {
        kind: "subnet_alpha",
        genesis_hash: row.network.genesis_hash,
        netuid: 7,
        registration_counter: null,
        unit: "alpha_atomic",
      },
      quote: {
        status: "exact",
        basis: { kind: "subnet_alpha", netuid: 7 },
        atomic_units: "100",
      },
    });
    assert.equal(
      V2StakePositionSchema.parse(residual).asset.unit,
      "alpha_atomic",
    );
    Object.assign(residual.asset, { registration_counter: "0" });
    assert.equal(V2StakePositionSchema.safeParse(residual).success, false);
  });

  test("stake DTO rejects inexact quantities malformed shares and contradictory attribution without throwing", () => {
    for (const invalid of [
      0,
      1.1,
      "01",
      "-0",
      "-1",
      "1.0",
      "1e3",
      "",
      "NaN",
      "x",
      "18446744073709551616",
    ]) {
      const row = modernAccountStakeRow();
      Object.assign(position(row).quote, { atomic_units: invalid });
      assert.equal(
        V2StakePositionSchema.safeParse(position(row)).success,
        false,
        String(invalid),
      );
    }
    for (const change of [
      (p: ReturnType<typeof position>) => {
        p.netuid = 1;
      },
      (p: ReturnType<typeof position>) => {
        Object.assign(p.quote, { basis: { kind: "subnet_alpha", netuid: 1 } });
      },
      (p: ReturnType<typeof position>) => {
        assert.ok(p.assessment.member !== null);
        Object.assign(p.assessment.member, { mantissa: "0", exponent: "-21" });
      },
      (p: ReturnType<typeof position>) => {
        assert.ok(p.assessment.member !== null);
        Object.assign(p.assessment.member, { mantissa: "1" });
      },
      (p: ReturnType<typeof position>) => {
        assert.ok(p.assessment.member !== null);
        Object.assign(p.assessment.member, { mantissa: "x" });
      },
      (p: ReturnType<typeof position>) => {
        assert.ok(p.assessment.member !== null);
        Object.assign(p.assessment.member, { exponent: "9223372036854775808" });
      },
      (p: ReturnType<typeof position>) => {
        p.observations.pool_balance = { status: "stored", scale_hex: "0x00" };
      },
      (p: ReturnType<typeof position>) => {
        p.assessment.share_state = "retired";
      },
      (p: ReturnType<typeof position>) => {
        p.assessment.member = null;
        p.assessment.denominator = null;
      },
      (p: ReturnType<typeof position>) => {
        p.assessment.share_state = "zero";
        p.assessment.member = null;
      },
      (p: ReturnType<typeof position>) => {
        p.assessment.share_state = "absent";
      },
      (p: ReturnType<typeof position>) => {
        Object.assign(p, { record: "member" });
      },
    ]) {
      const p = structuredClone(position(modernAccountStakeRow()));
      change(p);
      assert.equal(V2StakePositionSchema.safeParse(p).success, false);
    }
  });

  test("root DTO preserves claim-only rights signed watermarks and protocol custody", () => {
    const root = entitlement(modernAccountStakeRow(hash("b")));
    const parsed = V2RootEntitlementSchema.parse(root);
    assert.deepEqual(parsed.principal, { status: "absent_in_complete_join" });
    assert.equal(parsed.outcome.status, "assessed");
    if (parsed.outcome.status !== "assessed") throw new Error();
    assert.equal(parsed.outcome.value.root_principal_rao, "0");
    assert.equal(parsed.outcome.value.deferred_cash_rao, "9");
    assert.equal(parsed.outcome.value.deferred_cash_claimed_settled_rao, "-9");
    const custody = {
      ...root,
      key: {
        ...root.key,
        coldkey:
          "0x6d6f646c73756274656e7372626574612f657363000000000000000000000000",
      },
      outcome: { status: "protocol_custody" },
    };
    assert.equal(
      V2RootEntitlementSchema.parse(custody).outcome.status,
      "protocol_custody",
    );
    assert.equal(
      V2RootEntitlementSchema.safeParse({
        ...root,
        outcome: { status: "protocol_custody" },
      }).success,
      false,
    );
    for (const invalid of [
      "x",
      "-0",
      "01",
      "170141183460469231731687303715884105728",
      "-170141183460469231731687303715884105729",
    ]) {
      const value = structuredClone(root);
      assert.ok(value.outcome.status === "assessed");
      value.outcome.value.basket_claimed_shares = invalid;
      assert.equal(V2RootEntitlementSchema.safeParse(value).success, false);
    }
    const leaked = structuredClone(root);
    assert.ok(leaked.outcome.status === "assessed");
    Object.assign(leaked.outcome.value, { unattributed_pending_alpha: [] });
    assert.equal(V2RootEntitlementSchema.safeParse(leaked).success, false);
  });

  test("stake cursor is canonical bounded and separates same-hotkey record kinds", () => {
    const cursor = {
      version: 1 as const,
      network: "finney",
      genesis_hash: hash("0"),
      account_id: input.account_id,
      publication_id: "e".repeat(64),
      kind: "position" as const,
      hotkey: hash("0"),
      netuid: 0,
    };
    assert.deepEqual(
      decodeAccountStakeCursor(encodeAccountStakeCursor(cursor)),
      cursor,
    );
    const root = { ...cursor, kind: "root_entitlement" as const, netuid: null };
    assert.ok(compareAccountStakeKeys(cursor, root) < 0);
    assert.ok(
      compareAccountStakeKeys(root, { ...cursor, hotkey: hash("1") }) < 0,
    );
    assert.ok(
      compareAccountStakeKeys(
        { ...cursor, netuid: 1 },
        { ...cursor, netuid: 256 },
      ) < 0,
    );
    for (const invalid of [
      "",
      "=",
      "a".repeat(2049),
      encodeAccountStakeCursor(cursor) + "=",
      btoa('{"version":1}'),
    ])
      assert.throws(() => decodeAccountStakeCursor(invalid));
    assert.equal(
      V2AccountStakeCursorSchema.safeParse({ ...root, netuid: 0 }).success,
      false,
    );
    assert.equal(
      V2AccountStakeCursorSchema.safeParse({ ...cursor, netuid: null }).success,
      false,
    );
    assert.equal(
      V2AccountStakeCursorSchema.safeParse({ ...cursor, version: 2 }).success,
      false,
    );
    assert.equal(
      V2AccountStakeCursorSchema.safeParse({ ...cursor, extra: true }).success,
      false,
    );
  });

  test("stake operation pages positions and claimants once with independent execution and state metadata", async () => {
    const fixture = modernVerificationFixture();
    const operations = createV2Operations(fixture.executor, { now: clock });
    const first = await operations.list_account_stake(input);
    assert.equal(first.snapshot.spec_version, 486);
    assert.equal(first.stake.state.spec_version, 488);
    assert.notEqual(
      first.snapshot.metadata_digest,
      first.stake.state.metadata_digest,
    );
    assert.equal(first.snapshot.publication_id, MODERN_FIXTURE.publication);
    assert.equal(first.stake.publication_id, "e".repeat(64));
    assert.equal(first.entries[0].kind, "position");
    assert.ok(first.next_cursor);
    const second = await operations.list_account_stake({
      ...input,
      cursor: first.next_cursor,
    });
    assert.equal(second.entries[0].kind, "root_entitlement");
    assert.ok(second.next_cursor);
    const third = await operations.list_account_stake({
      ...input,
      cursor: second.next_cursor,
    });
    assert.equal(third.entries[0].kind, "position");
    assert.equal(third.next_cursor, null);
    assert.deepEqual(third.stake, first.stake);
    assert.deepEqual(first.freshness, {
      status: "current",
      age_seconds: 0,
      finalized_lag_blocks: "0",
      target_seconds: 3600,
      target_blocks: null,
    });
    const claimOnly = await operations.list_account_stake({
      ...input,
      account_id: hash("b"),
      limit: 10,
    });
    assert.equal(claimOnly.entries.length, 1);
    assert.equal(claimOnly.entries[0].kind, "root_entitlement");
    const empty = await operations.list_account_stake({
      ...input,
      account_id: hash("c"),
    });
    assert.equal(empty.stake.census_complete, true);
    assert.deepEqual(empty.entries, []);
    assert.equal(empty.next_cursor, null);
    assert.deepEqual(fixture.errors, []);
  });

  test("stake cursor conflicts fail before querying and absent publications never become empty success", async () => {
    const f = modernVerificationFixture();
    const operations = createV2Operations(f.executor, { now: clock });
    const first = await operations.list_account_stake(input);
    assert.ok(first.next_cursor);
    for (const bad of [
      { ...input, account_id: hash("b"), cursor: first.next_cursor },
      { ...input, network: "foreign", cursor: first.next_cursor },
      { ...input, publication_id: "f".repeat(64), cursor: first.next_cursor },
      { ...input, cursor: "not_a_cursor" },
      { ...input, limit: 11 },
      { ...input, unknown: true },
    ]) {
      const before = f.calls.length;
      await assert.rejects(
        operations.list_account_stake(bad),
        (e) => e instanceof V2OperationError && e.code === "invalid_input",
      );
      assert.equal(f.calls.length, before);
    }
    await assert.rejects(
      operations.list_account_stake({
        ...input,
        publication_id: "f".repeat(64),
      }),
      unavailable,
    );
    const missing = createV2Operations(
      {
        async query() {
          return { rows: [] };
        },
      },
      { now: clock },
    );
    await assert.rejects(missing.list_account_stake(input), unavailable);
    const unavailableContract = createV2Operations(
      {
        async query() {
          throw Object.assign(new Error("private diagnostic"), {
            code: "42P01",
          });
        },
      },
      { now: clock },
    );
    await assert.rejects(
      unavailableContract.list_account_stake(input),
      (e) =>
        unavailable(e) &&
        e instanceof Error &&
        !e.message.includes("private diagnostic"),
    );
  });

  test("stake publication body ownership ordering and budget refusals fail closed", async () => {
    for (const change of [
      (row: Row) => {
        row.within_budget = false;
      },
      (row: Row) => {
        row.has_more = true;
      },
      (row: Row) => {
        row.entries.push(row.entries[0]);
      },
      (row: Row) => {
        position(row).coldkey = hash("b");
      },
      (row: Row) => {
        position(row).asset.genesis_hash = hash("b");
      },
      (row: Row) => {
        entitlement(row).snapshot_id = "a".repeat(64);
      },
      (row: Row) => {
        const value = entitlement(row);
        assert.ok(value.outcome.status === "assessed");
        value.outcome.value.state_metadata_sha256 = "f".repeat(64);
      },
      (row: Row) => {
        row.network.id = "foreign";
      },
      (row: Row) => {
        row.stake.runtime_semantics_attested = true;
      },
      (row: Row) => {
        row.stake.state.block_hash = hash("f");
      },
      (row: Row) => {
        Object.assign(position(row).quote, { atomic_units: 100 });
      },
      (row: Row) => {
        row.entries.reverse();
      },
      (row: Row) => {
        row.entries = Array.from({ length: 11 }, () => row.entries[0]);
      },
    ])
      await assert.rejects(
        changed(change).operations.list_account_stake({ ...input, limit: 10 }),
        unavailable,
      );
    const root = changed((row) => {
      row.entries = [row.entries[1]];
      row.has_more = true;
    });
    const page = await root.operations.list_account_stake(input);
    assert.ok(page.next_cursor);
    await assert.rejects(
      root.operations.list_account_stake({
        ...input,
        cursor: page.next_cursor,
      }),
      unavailable,
    );
  });

  test("stake freshness follows the hourly census and independently requires a recent finalized observation", async () => {
    const later = new Date(Date.parse(MODERN_FIXTURE.now) + 60_000);
    const fresh = await changed(
      (row) => {
        Object.assign(row, { finalized_observed_at: later.toISOString() });
      },
      () => later,
    ).operations.list_account_stake({ ...input, limit: 10 });
    assert.equal(fresh.freshness.status, "current");
    assert.equal(fresh.freshness.age_seconds, 60);
    const staleHead = await changed(
      () => {},
      () => later,
    ).operations.list_account_stake({ ...input, limit: 10 });
    assert.equal(staleHead.freshness.status, "stale");
    const expired = new Date(Date.parse(MODERN_FIXTURE.now) + 3600_001);
    const stale = await changed(
      (row) => {
        Object.assign(row, { finalized_observed_at: expired.toISOString() });
      },
      () => expired,
    ).operations.list_account_stake({ ...input, limit: 10 });
    assert.equal(stale.freshness.status, "stale");
    const unknown = await changed((row) =>
      Object.assign(row, {
        finalized_observed_height: null,
        finalized_observed_hash: null,
        finalized_observed_at: null,
      }),
    ).operations.list_account_stake({ ...input, limit: 10 });
    assert.equal(unknown.freshness.status, "unknown");
    assert.equal(unknown.freshness.finalized_lag_blocks, null);
    for (const change of [
      (row: Row) => {
        row.finalized_observed_hash = hash("f");
      },
      (row: Row) => {
        row.finalized_observed_height = "122";
      },
      (row: Row) => {
        Object.assign(row, { finalized_observed_at: null });
      },
      (row: Row) => {
        Object.assign(row.stake, { observed_at: "not a clock" });
      },
      (row: Row) => {
        Object.assign(row.stake, {
          published_at: new Date(
            Date.parse(MODERN_FIXTURE.now) + 10_000,
          ).toISOString(),
        });
      },
    ])
      await assert.rejects(
        changed(change).operations.list_account_stake({ ...input, limit: 10 }),
        unavailable,
      );
    await assert.rejects(
      changed(
        () => {},
        () => new Date(Number.NaN),
      ).operations.list_account_stake({ ...input, limit: 10 }),
      unavailable,
    );
  });

  test("stake REST and canonical client bind the stake publication rather than its execution publication", async () => {
    const f = modernVerificationFixture();
    const operations = createV2Operations(f.executor, { now: clock });
    const handler = createV2Handler(operations);
    const urls: string[] = [];
    const client = createV2ReadClient({
      origin: MODERN_FIXTURE.origin,
      fetch: (url, init) => {
        urls.push(String(url));
        return handler(new Request(url, init));
      },
    });
    const first = await client.read("list_account_stake", {
      ...input,
      publication_id: "e".repeat(64),
    });
    assert.equal(first.stake.publication_id, "e".repeat(64));
    assert.ok(urls[0].includes("/accounts/" + input.account_id + "/stake?"));
    assert.ok(first.next_cursor);
    const second = await client.read("list_account_stake", {
      ...input,
      cursor: first.next_cursor,
    });
    assert.equal(second.entries[0].kind, "root_entitlement");
    for (const query of [
      "limit=11",
      "unknown=true",
      "limit=1&limit=1",
      "cursor=x",
    ]) {
      assert.equal(
        (
          await handler(
            new Request(
              MODERN_FIXTURE.origin +
                `/api/v2/networks/finney/accounts/${input.account_id}/stake?${query}`,
            ),
          )
        ).status,
        400,
      );
    }
    assert.equal(
      (
        await handler(
          new Request(
            MODERN_FIXTURE.origin +
              `/api/v2/networks/finney/accounts/${input.account_id}/stake`,
            { method: "POST" },
          ),
        )
      ).status,
      405,
    );
    const before = urls.length;
    await assert.rejects(
      client.read("list_account_stake", {
        ...input,
        account_id: hash("b"),
        cursor: first.next_cursor,
      }),
      (e) => e instanceof V2ReadClientError && e.code === "invalid_input",
    );
    assert.equal(urls.length, before);
  });

  test("stake client refuses forged provenance quantities continuations and unbounded bodies", async () => {
    const f = modernVerificationFixture();
    const valid = await createV2Operations(f.executor, {
      now: clock,
    }).list_account_stake({ ...input, limit: 2 });
    for (const change of [
      (page: typeof valid) => {
        page.account_id = hash("b");
      },
      (page: typeof valid) => {
        page.stake.publication_id = "f".repeat(64);
      },
      (page: typeof valid) => {
        page.entries.reverse();
      },
      (page: typeof valid) => {
        const e = page.entries[0];
        assert.ok(e.kind === "position");
        e.position.coldkey = hash("b");
      },
      (page: typeof valid) => {
        page.next_cursor = "bad";
      },
      (page: typeof valid) => {
        const c = decodeAccountStakeCursor(page.next_cursor!);
        page.next_cursor = encodeAccountStakeCursor({
          ...c,
          account_id: hash("b"),
        });
      },
      (page: typeof valid) => {
        const e = page.entries[0];
        assert.ok(e.kind === "position");
        Object.assign(e.position.quote, { atomic_units: 1.1 });
      },
      (page: typeof valid) => {
        let nested: unknown = null;
        for (let i = 0; i < 34; i++) nested = { child: nested };
        Object.assign(page.entries[0], { extra: nested });
      },
    ]) {
      const value = structuredClone(valid);
      change(value);
      const client = createV2ReadClient({
        origin: MODERN_FIXTURE.origin,
        fetch: async () => Response.json(value),
      });
      await assert.rejects(
        client.read("list_account_stake", {
          ...input,
          limit: 2,
          publication_id: valid.stake.publication_id,
        }),
        (e) => e instanceof V2ReadClientError,
      );
    }
    assert.ok(V2AccountStakeSchema.safeParse(valid).success);
    assert.deepEqual(accountStakeKey(valid.entries[0]), {
      kind: "position",
      hotkey: hash("0"),
      netuid: 0,
    });
  });
}
