import assert from "node:assert/strict";
import {
  V2AccountBalanceSchema,
  V2AccountInfoSchema,
} from "../../schemas-src/v2/balance.ts";
import {
  MODERN_FIXTURE,
  modernAccountBalanceRow,
  modernVerificationFixture,
} from "../../scripts/lib/modern-verification-fixture.ts";
import {
  createV2Operations,
  V2OperationError,
} from "../../src/v2/operations.ts";
import { createV2Handler } from "../../src/v2/api.ts";
import { createV2ReadClient, V2ReadClientError } from "../../src/v2/client.ts";

const account = `0x${"a".repeat(64)}`;
const input = { network: "finney", account_id: account };
const clock = () => new Date(MODERN_FIXTURE.now);
type Row = ReturnType<typeof modernAccountBalanceRow>;
function dto(row = modernAccountBalanceRow()) {
  return {
    api_version: "2",
    account_id: account,
    network: row.network,
    snapshot: row.snapshot,
    balance: row.balance,
    result: row.result,
    freshness: {
      status: "current",
      age_seconds: 0,
      finalized_lag_blocks: "0",
      target_seconds: 30,
      target_blocks: 2,
    },
  };
}
function unavailable(error: unknown) {
  return error instanceof V2OperationError && error.code === "data_unavailable";
}
function changed(change: (row: Row) => void = () => {}, now = clock) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    operations: createV2Operations(
      {
        async query() {
          calls++;
          const row = modernAccountBalanceRow();
          change(row);
          return { rows: [row] };
        },
      },
      { now },
    ),
  };
}

export function registerAccountBalanceChecks(
  test: (name: string, check: () => void | Promise<void>) => void,
) {
  test("balance DTO preserves stored zero and explicit runtime defaults with exact quantities", () => {
    const value = V2AccountBalanceSchema.parse(dto());
    assert.ok(value.result.status === "stored");
    assert.equal(value.result.account.free_rao, "9007199254740993");
    assert.equal(value.result.account.reserved_rao, "7");
    assert.equal(value.result.account.frozen_rao, "3");
    assert.equal(value.snapshot.spec_version, 486);
    assert.equal(value.balance.state.spec_version, 488);
    assert.notEqual(
      value.snapshot.metadata_digest,
      value.balance.state.metadata_digest,
    );
    const zero = {
      ...value.result.account,
      nonce: "0",
      consumers: "0",
      providers: "0",
      sufficients: "0",
      free_rao: "0",
      reserved_rao: "0",
      frozen_rao: "0",
    };
    assert.equal(
      V2AccountBalanceSchema.parse({
        ...value,
        result: { status: "stored", account: zero },
      }).result.status,
      "stored",
    );
    assert.equal(
      V2AccountBalanceSchema.parse({
        ...value,
        result: { status: "not_stored", runtime_default: zero },
      }).result.status,
      "not_stored",
    );
    const maximum = V2AccountInfoSchema.parse({
      ...zero,
      nonce: "4294967295",
      consumers: "4294967295",
      providers: "4294967295",
      sufficients: "4294967295",
      free_rao: "18446744073709551615",
      reserved_rao: "18446744073709551615",
      frozen_rao: "18446744073709551615",
      flags: "340282366920938463463374607431768211455",
    });
    assert.equal(maximum.flags, "340282366920938463463374607431768211455");
    const old = structuredClone(value);
    Object.assign(old.balance, {
      profile_revision: "subtensor-486-account-info-v1",
      upstream_revision: "8b2a978a98c0d94300dd7c68b190b24b974b7d02",
    });
    Object.assign(old.balance.state, {
      spec_version: 486,
      metadata_digest:
        "142e2f2735d9585567fd71e080554a2a0ec10d4ad0bcedb4993e87e473ddd852",
    });
    assert.equal(
      V2AccountBalanceSchema.parse(old).balance.state.spec_version,
      486,
    );
  });

  test("balance DTO rejects malformed quantities contradictory defaults and provenance without throwing", () => {
    for (const field of [
      "nonce",
      "consumers",
      "providers",
      "sufficients",
      "free_rao",
      "reserved_rao",
      "frozen_rao",
      "flags",
    ] as const) {
      for (const invalid of [
        0,
        null,
        true,
        "",
        "x",
        "01",
        "-1",
        "-0",
        "1.0",
        "1e3",
        "0\n",
        " 1",
        "1 ",
        "9".repeat(1000),
        field === "flags"
          ? "340282366920938463463374607431768211456"
          : field.endsWith("_rao")
            ? "18446744073709551616"
            : "4294967296",
      ]) {
        const row = modernAccountBalanceRow();
        Object.assign(row.result.account, { [field]: invalid });
        assert.equal(
          V2AccountBalanceSchema.safeParse(dto(row)).success,
          false,
          `${field}:${String(invalid).slice(0, 40)}`,
        );
      }
    }
    for (const change of [
      (v: ReturnType<typeof dto>) =>
        Object.assign(v.result, {
          status: "not_stored",
          runtime_default: v.result.account,
        }),
      (v: ReturnType<typeof dto>) => Object.assign(v.result, { extra: true }),
      (v: ReturnType<typeof dto>) =>
        Object.assign(v.result.account, { extra: true }),
      (v: ReturnType<typeof dto>) =>
        Object.assign(v.result.account, { account_id: `0x${"b".repeat(64)}` }),
      (v: ReturnType<typeof dto>) =>
        Object.assign(v.balance, { generation: "0" }),
      (v: ReturnType<typeof dto>) =>
        Object.assign(v.balance, { generation: "0\n" }),
      (v: ReturnType<typeof dto>) => {
        v.snapshot.block_number = v.balance.state.block_number = "123\n";
      },
      (v: ReturnType<typeof dto>) => {
        v.network.genesis_hash = `0x${"b".repeat(64)}`;
      },
      (v: ReturnType<typeof dto>) =>
        Object.assign(v.balance, { lookup_scope: "census" }),
      (v: ReturnType<typeof dto>) => Object.assign(v.balance, { unit: "tao" }),
      (v: ReturnType<typeof dto>) =>
        Object.assign(v.balance, { state_proof_verified: true }),
      (v: ReturnType<typeof dto>) =>
        Object.assign(v.balance, { runtime_semantics_attested: true }),
      (v: ReturnType<typeof dto>) =>
        Object.assign(v.balance, { profile_revision: "unreviewed" }),
      (v: ReturnType<typeof dto>) =>
        Object.assign(v.balance, { upstream_revision: "c".repeat(40) }),
      (v: ReturnType<typeof dto>) =>
        Object.assign(v.balance.state, { metadata_digest: "f".repeat(64) }),
      (v: ReturnType<typeof dto>) =>
        Object.assign(v.balance.state, { spec_version: 489 }),
      (v: ReturnType<typeof dto>) =>
        Object.assign(v.balance.state, { transaction_version: 2 }),
      (v: ReturnType<typeof dto>) =>
        Object.assign(v.balance.state, { block_number: "124" }),
      (v: ReturnType<typeof dto>) =>
        Object.assign(v.balance.state, { block_hash: `0x${"b".repeat(64)}` }),
      (v: ReturnType<typeof dto>) =>
        Object.assign(v.balance.state, {
          observed_at: "2026-11-06T13:00:00.000Z",
        }),
      (v: ReturnType<typeof dto>) =>
        Object.assign(v.balance, { block_publication_id: "f".repeat(64) }),
    ]) {
      const value = dto();
      change(value);
      assert.equal(V2AccountBalanceSchema.safeParse(value).success, false);
    }
    const value = dto();
    const zero = {
      ...value.result.account,
      nonce: "0",
      consumers: "0",
      providers: "0",
      sufficients: "0",
      free_rao: "0",
      reserved_rao: "0",
      frozen_rao: "0",
      flags: "0",
    };
    assert.equal(
      V2AccountBalanceSchema.safeParse({
        ...value,
        result: { status: "not_stored", runtime_default: zero },
      }).success,
      false,
    );
    for (const field of [
      "nonce",
      "consumers",
      "providers",
      "sufficients",
      "free_rao",
      "reserved_rao",
      "frozen_rao",
    ] as const) {
      const nonzero = {
        ...zero,
        flags: "170141183460469231731687303715884105728",
        [field]: "1",
      };
      assert.equal(V2AccountInfoSchema.safeParse(nonzero).success, true);
      assert.equal(
        V2AccountBalanceSchema.safeParse({
          ...value,
          result: { status: "not_stored", runtime_default: nonzero },
        }).success,
        false,
        field,
      );
    }
  });

  test("balance operation selects only eligible exact account observations", async () => {
    let calls = 0;
    const operations = createV2Operations(
      {
        async query(sql, values) {
          calls++;
          assert.deepEqual(values, [input.network, account, "e".repeat(64)]);
          assert.ok(
            sql.includes("FROM chain.eligible_account_balance_observations e"),
          );
          assert.ok(
            sql.indexOf("e.account_id=$2") <
              sql.indexOf("ORDER BY e.block_number"),
          );
          assert.ok(sql.includes("cp.publication_id=v.publication_id"));
          assert.ok(!sql.includes("b.publication_id=e.block_publication_id"));
          return { rows: [modernAccountBalanceRow()] };
        },
      },
      { now: clock },
    );
    const value = await operations.get_account_balance({
      ...input,
      publication_id: "e".repeat(64),
    });
    assert.equal(value.balance.unit, "rao");
    assert.equal(calls, 1);
    for (const invalid of [
      { ...input, account_id: account + "\n" },
      { ...input, network: "finney\n" },
      { ...input, publication_id: "e".repeat(64) + "\n" },
      { ...input, cursor: "x" },
      { ...input, limit: 1 },
      { ...input, account_id: "0xdead" },
    ]) {
      await assert.rejects(
        operations.get_account_balance(invalid),
        (e) => e instanceof V2OperationError && e.code === "invalid_input",
      );
    }
    assert.equal(calls, 1);
    for (const rows of [
      [],
      [modernAccountBalanceRow(), modernAccountBalanceRow()],
      [{}],
    ]) {
      await assert.rejects(
        createV2Operations(
          {
            async query() {
              return { rows };
            },
          },
          { now: clock },
        ).get_account_balance(input),
        unavailable,
      );
    }
    for (const code of ["42P01", "42703", "42501", "08006"]) {
      const original = Object.assign(new Error("private diagnostic"), { code });
      const selected = createV2Operations(
        {
          async query() {
            throw original;
          },
        },
        { now: clock },
      );
      await assert.rejects(selected.get_account_balance(input), (e) =>
        ["42P01", "42703"].includes(code)
          ? unavailable(e) &&
            e instanceof Error &&
            !e.message.includes("private diagnostic")
          : e === original,
      );
    }
    for (const change of [
      (row: Row) => {
        row.network.id = "foreign";
      },
      (row: Row) => {
        row.result.account.account_id = `0x${"b".repeat(64)}`;
      },
      (row: Row) => {
        row.balance.publication_id = "f".repeat(64);
      },
      (row: Row) => {
        row.balance.state.metadata_digest = "f".repeat(64);
      },
    ])
      await assert.rejects(
        changed(change).operations.get_account_balance({
          ...input,
          publication_id: "e".repeat(64),
        }),
        unavailable,
      );
  });

  test("balance freshness requires dated state and independent finalized head evidence", async () => {
    for (const [milliseconds, lag, status] of [
      [30000, "125", "current"],
      [30001, "123", "stale"],
      [0, "126", "stale"],
    ] as const) {
      const later = () =>
        new Date(Date.parse(MODERN_FIXTURE.now) + milliseconds);
      const value = await changed((row) => {
        row.finalized_observed_height = lag;
        row.finalized_observed_at = later().toISOString();
      }, later).operations.get_account_balance(input);
      assert.equal(value.freshness.status, status);
      assert.equal(value.freshness.target_seconds, 30);
      assert.equal(value.freshness.target_blocks, 2);
    }
    const stale = await changed(
      () => {},
      () => new Date(Date.parse(MODERN_FIXTURE.now) + 60000),
    ).operations.get_account_balance(input);
    assert.equal(stale.freshness.status, "stale");
    const unknown = await changed((row) =>
      Object.assign(row, {
        finalized_observed_height: null,
        finalized_observed_hash: null,
        finalized_observed_at: null,
      }),
    ).operations.get_account_balance(input);
    assert.equal(unknown.freshness.status, "unknown");
    assert.equal(unknown.result.status, "stored");
    for (const change of [
      (row: Row) => {
        row.finalized_observed_height = "122";
      },
      (row: Row) => {
        row.finalized_observed_hash = `0x${"b".repeat(64)}`;
      },
      (row: Row) => {
        row.finalized_observed_height = "123\n";
        row.finalized_observed_hash = `0x${"b".repeat(64)}`;
      },
      (row: Row) => {
        Object.assign(row, { finalized_observed_at: null });
      },
      (row: Row) => {
        Object.assign(row, { finalized_observed_height: null });
      },
      (row: Row) => {
        Object.assign(row, { finalized_observed_hash: null });
      },
      (row: Row) => {
        row.finalized_observed_at = "not a timestamp";
      },
      (row: Row) => {
        row.finalized_observed_at = new Date(
          Date.parse(MODERN_FIXTURE.now) + 6000,
        ).toISOString();
      },
      (row: Row) => {
        row.balance.observed_at = row.balance.state.observed_at = new Date(
          Date.parse(MODERN_FIXTURE.now) + 6000,
        ).toISOString();
      },
      (row: Row) => {
        row.balance.published_at = new Date(
          Date.parse(MODERN_FIXTURE.now) + 6000,
        ).toISOString();
      },
      (row: Row) => {
        row.snapshot.published_at = new Date(
          Date.parse(MODERN_FIXTURE.now) + 6000,
        ).toISOString();
      },
      (row: Row) => {
        row.snapshot.observed_at = new Date(
          Date.parse(MODERN_FIXTURE.now) + 6000,
        ).toISOString();
      },
    ])
      await assert.rejects(
        changed(change).operations.get_account_balance(input),
        unavailable,
      );
    await assert.rejects(
      changed(
        () => {},
        () => new Date(NaN),
      ).operations.get_account_balance(input),
      unavailable,
    );
  });

  test("balance REST owns only strict balance paths and publication selectors", async () => {
    const fixture = modernVerificationFixture();
    const handler = createV2Handler(
      createV2Operations(fixture.executor, { now: clock }),
    );
    const path = `${MODERN_FIXTURE.origin}/api/v2/networks/finney/accounts/${account}/balance`;
    const response = await handler(
      new Request(path + "?publication_id=" + "e".repeat(64)),
    );
    assert.equal(response.status, 200);
    assert.equal(
      V2AccountBalanceSchema.parse(await response.json()).balance
        .publication_id,
      "e".repeat(64),
    );
    const before = fixture.calls.length;
    for (const query of [
      "limit=1",
      "cursor=x",
      "unknown=true",
      "publication_id=bad",
      "publication_id=" + "e".repeat(64) + "&publication_id=" + "e".repeat(64),
    ])
      assert.equal(
        (await handler(new Request(path + "?" + query))).status,
        400,
      );
    assert.equal(
      (await handler(new Request(path, { method: "POST" }))).status,
      405,
    );
    assert.equal((await handler(new Request(path + "/"))).status, 404);
    assert.equal(fixture.calls.length, before);
    assert.equal(
      (await handler(new Request(path + "?publication_id=" + "f".repeat(64))))
        .status,
      503,
    );
  });

  test("balance client binds account genesis and balance publication before accepting a response", async () => {
    const selected = { ...input, publication_id: "e".repeat(64) };
    for (const change of [
      (value: ReturnType<typeof dto>) => {
        value.account_id =
          value.result.account.account_id = `0x${"b".repeat(64)}`;
      },
      (value: ReturnType<typeof dto>) => {
        value.balance.publication_id = "f".repeat(64);
      },
      (value: ReturnType<typeof dto>) => {
        value.network.id = "foreign";
      },
    ]) {
      const value = dto();
      change(value);
      const client = createV2ReadClient({
        origin: MODERN_FIXTURE.origin,
        fetch: async () => Response.json(value),
      });
      await assert.rejects(
        client.read("get_account_balance", selected, {
          expectedGenesisHash: modernAccountBalanceRow().network.genesis_hash,
        }),
        (e) => e instanceof V2ReadClientError && e.code === "identity_mismatch",
      );
    }
    let calls = 0;
    const client = createV2ReadClient({
      origin: MODERN_FIXTURE.origin,
      fetch: async (url, init) => {
        calls++;
        assert.equal(
          String(url),
          `${MODERN_FIXTURE.origin}/api/v2/networks/finney/accounts/${account}/balance?publication_id=${selected.publication_id}`,
        );
        assert.equal(new Request(url, init).method, "GET");
        return Response.json(dto());
      },
    });
    assert.deepEqual(
      await client.read("get_account_balance", selected),
      V2AccountBalanceSchema.parse(dto()),
    );
    await assert.rejects(
      client.read("get_account_balance", selected, {
        expectedGenesisHash: `0x${"b".repeat(64)}`,
      }),
      (e) => e instanceof V2ReadClientError && e.code === "identity_mismatch",
    );
    await assert.rejects(
      client.read("get_account_balance", {
        ...selected,
        account_id: account + "\n",
      }),
      (e) => e instanceof V2ReadClientError && e.code === "invalid_input",
    );
    assert.equal(calls, 2);
    const bad = dto();
    Object.assign(bad.result.account, { free_rao: 9007199254740992 });
    await assert.rejects(
      createV2ReadClient({
        origin: MODERN_FIXTURE.origin,
        fetch: async () => Response.json(bad),
      }).read("get_account_balance", input),
      (e) => e instanceof V2ReadClientError && e.code === "response_rejected",
    );
  });
}
