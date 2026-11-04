import { expect, test, vi } from "vitest";
import { selectedNativeRelationalSql } from "../src/native-relational-read.ts";
import type { ReadStoreDb } from "../src/read-store.ts";
import worker from "../workers/data-api.ts";
import { dataApiEnv } from "./helpers/worker-env.ts";

function fixture(
  tables = ["surface_status", "account_identity", "account_identity_history"],
  rows: Record<string, unknown>[] = [{ selected: true }],
) {
  const calls: { text: string; values: readonly unknown[] }[] = [];
  const store: ReadStoreDb = {
    async query<Row>(text: string, values: readonly unknown[] = []) {
      calls.push({ text, values });
      return rows as Row[];
    },
    async first() {
      throw new Error("Unexpected first");
    },
  };
  return { calls, env: { NATIVE_READ_STORE: { tables, store } } };
}

test("relational selection requires a complete native owner and does not admit document views", () => {
  for (const env of [undefined, null, {}, 1])
    expect(selectedNativeRelationalSql(env, ["surface_status"])).toBeNull();
  const f = fixture();
  for (const tables of [[], ["neurons"], ["surface_status", "neuron_daily"]])
    expect(selectedNativeRelationalSql(f.env, tables)).toBeUndefined();
  expect(() =>
    selectedNativeRelationalSql(f.env, ["subnet_hyperparams"]),
  ).toThrow("does not own");
  expect(() =>
    selectedNativeRelationalSql({ NATIVE_READ_STORE: null }, [
      "surface_status",
    ]),
  ).toThrow("invalid");
});

test("tagged and positional relational SQL share the existing native reader", async () => {
  const f = fixture();
  const sql = selectedNativeRelationalSql(f.env, ["surface_status"])!;
  expect(
    await sql`SELECT surface_id FROM surface_status WHERE last_checked >= ${5}`,
  ).toEqual([{ selected: true }]);
  await sql.unsafe(
    "SELECT '?' FROM surface_status WHERE last_checked >= ?",
    [3],
  );
  expect(f.calls).toEqual([
    {
      text: "SELECT surface_id FROM surface_status WHERE last_checked >= $1::bigint",
      values: ["5"],
    },
    {
      text: "SELECT '?' FROM surface_status WHERE last_checked >= $1::bigint",
      values: ["3"],
    },
  ]);
});

test("relational numeric bounds preserve int64 comparisons and health wire values", async () => {
  const f = fixture(
    ["surface_status", "subnet_hyperparams"],
    [{ netuid: "9007199254740993", latency_ms: null, status: "up" }],
  );
  const sql = selectedNativeRelationalSql(f.env, ["surface_status"])!;
  expect(
    await sql`SELECT netuid,latency_ms,status FROM surface_status WHERE last_checked >= ${10.5}`,
  ).toEqual([{ netuid: 9007199254740992, latency_ms: null, status: "up" }]);
  await sql.unsafe(
    "SELECT netuid FROM subnet_hyperparams WHERE netuid = ?",
    [1111111111111111168],
  );
  expect(f.calls[0].values).toEqual([10.5]);
  expect(f.calls[1].values).toEqual(["1111111111111111168"]);
  for (const bound of [-1e30, 1e30]) {
    await sql.unsafe("SELECT netuid FROM subnet_hyperparams WHERE netuid = ?", [
      bound,
    ]);
    expect(f.calls.at(-1)?.text).toContain("$1::numeric");
    expect(f.calls.at(-1)?.values).toEqual([BigInt(bound).toString()]);
  }
  for (const bound of [Infinity, "3"])
    await expect(
      sql.unsafe("SELECT netuid FROM subnet_hyperparams WHERE netuid = ?", [
        bound,
      ]),
    ).rejects.toThrow("finite");
  await sql.unsafe("SELECT netuid FROM subnet_hyperparams");
});

test("identity equality binds original UTF-8 bytes without truncating request NUL", async () => {
  const f = fixture();
  const sql = selectedNativeRelationalSql(f.env, [
    "account_identity",
    "account_identity_history",
  ])!;
  await sql.unsafe("SELECT name FROM account_identity WHERE account = ?", [
    "a\0b",
  ]);
  await sql.unsafe(
    "SELECT id FROM account_identity_history WHERE account = ? AND (observed_at,id) < (?,?) LIMIT ?",
    ["é", 20, 8, 4],
  );
  expect(f.calls).toEqual([
    {
      text: "SELECT name FROM account_identity WHERE convert_to(account,'UTF8') = $1::bytea",
      values: [Buffer.from("a\0b")],
    },
    {
      text: "SELECT id FROM account_identity_history WHERE account = $1 AND (observed_at,id) < ($2,$3) LIMIT $4",
      values: ["é", 20, 8, 4],
    },
  ]);
  await sql.unsafe("SELECT name FROM account_identity WHERE account = ?", [
    "😀",
  ]);
  expect(f.calls.at(-1)).toEqual({
    text: "SELECT name FROM account_identity WHERE account = $1",
    values: ["😀"],
  });
  await sql.unsafe("SELECT name FROM account_identity WHERE account = ?", [
    "\ud800",
  ]);
  expect(f.calls.at(-1)).toEqual({
    text: "SELECT name FROM account_identity WHERE convert_to(account,'UTF8') = $1::bytea",
    values: [Buffer.from("\ud800")],
  });
  await expect(
    sql.unsafe("SELECT name FROM account_identity WHERE account = ?", [5]),
  ).rejects.toThrow("must be text");
});

test("actual relational routes select native reads and keep failed reads opaque", async () => {
  const f = fixture([
    "surface_status",
    "subnet_hyperparams",
    "subnet_hyperparams_history",
    "account_identity",
    "account_identity_history",
  ]);
  const env = { ...dataApiEnv(), ...f.env };
  const ctx = { waitUntil() {} } as unknown as ExecutionContext;
  const paths = [
    "internal/health-status-live",
    "subnets/7/hyperparameters",
    "subnets/7/hyperparameters/history",
    "accounts/a/identity",
    "accounts/a/identity-history",
  ];
  for (const path of paths)
    expect(
      (
        await worker.fetch(
          new Request(`https://example.com/api/v1/${path}`),
          env,
          ctx,
        )
      ).status,
    ).toBe(200);
  expect(
    (
      await worker.fetch(
        new Request("https://example.com/api/v1/subnets/7/neurons/1"),
        env,
        ctx,
      )
    ).status,
  ).toBe(503);
  expect(
    (
      await worker.fetch(
        new Request("https://example.com/api/v1/internal/health-status-live"),
        dataApiEnv(),
        ctx,
      )
    ).status,
  ).toBe(503);
  env.NATIVE_READ_STORE.store.query = async () => {
    throw new Error("private backend details");
  };
  const report = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const path of paths) {
      const response = await worker.fetch(
        new Request(`https://example.com/api/v1/${path}`),
        env,
        ctx,
      );
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: "data query failed" });
    }
  } finally {
    report.mockRestore();
  }
});
