import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { EXPORT_PROJECTION } from "../generated/db/export-projection.ts";
import { exportProjectionSource } from "../scripts/generate-export-projection.ts";
import { D1_EXPORT_TABLES } from "../src/d1-export-tables.ts";
import { logicalType } from "../src/d1-state-export.ts";
import { createPgStateExport } from "../src/pg-state-export.ts";
import { createSqliteDocumentDecoder } from "../src/sqlite-document-decoder.ts";
import type { PgTransaction } from "../src/pg-pool.ts";

const decoder = createSqliteDocumentDecoder({ maxAuditBytes: 524288 });
afterAll(() => decoder.close());
const views = new Set(["neurons", "neuron_daily", "account_position_daily"]);
type Trigger = {
  table: string;
  name: string;
  type: number;
  enabled: string;
  function: string;
  args: string;
};
type Column = { name: string; type: string };
type UnitReply = {
  rows: unknown[][];
  revision: number;
  next_cursor: unknown[] | null;
  days: unknown[];
  columns: unknown[];
  projection_sha256: string;
};
type Options = {
  table?: string;
  rows?: Record<string, string | null>[];
  overflow?: boolean;
  payload?: string;
  revision?: string;
  missingRevision?: boolean;
  count?: string | null;
  extract?: ReturnType<typeof createSqliteDocumentDecoder>["extract"];
  numericAffinity?: ReturnType<
    typeof createSqliteDocumentDecoder
  >["numericAffinity"];
  document?: Uint8Array | null;
  columns?: (columns: Column[]) => Column[];
  triggers?: (triggers: Trigger[]) => Trigger[];
};
const projection: Readonly<
  Record<string, readonly (readonly [string, string, number, number])[]>
> = EXPORT_PROJECTION.tables;
function fixture(options: Options = {}) {
  const table = options.table ?? "account_balances";
  const sources = Object.keys(D1_EXPORT_TABLES).flatMap((name) =>
    views.has(name) ? [name + "_members", name + "_documents"] : [name],
  );
  const required = views.has(table)
    ? [table + "_members", table + "_documents"]
    : [table];
  const triggers = required.flatMap((name) => [
    {
      table: name,
      name: "native_export_revision",
      type: 62,
      enabled: "O",
      function: "native_export_bump",
      args: Buffer.from(table + "\0").toString("hex"),
    },
    ...(D1_EXPORT_TABLES[table]!.daily
      ? [
          {
            table: name,
            name: "native_export_closed_day",
            type: 29,
            enabled: "O",
            function: "native_export_day_bump",
            args: Buffer.from(
              table +
                "\0" +
                (name.endsWith("_documents") ? "day" : "snapshot_date") +
                "\0",
            ).toString("hex"),
          },
        ]
      : []),
  ]);
  const columns = projection[table]!.map(([name, type]) => ({
    name,
    type:
      type === "TEXT"
        ? "text"
        : type === "REAL"
          ? "double precision"
          : logicalType(table, name, type) === "bool"
            ? "boolean"
            : "bigint",
  }));
  const row = Object.fromEntries(
    columns.map(({ name, type }) => [
      name,
      type === "text"
        ? "value"
        : type === "boolean"
          ? "true"
          : type === "double precision"
            ? "0.1"
            : "1",
    ]),
  );
  if (views.has(table))
    Object.assign(row, {
      netuid: "1",
      uid: "1",
      hotkey: "h",
      coldkey: "c",
      account: "v",
      shard: "0",
      snapshot_date: "2020-01-01",
    });
  D1_EXPORT_TABLES[table]!.keys.forEach((key, index) => {
    row[`_key${index}`] =
      key === "coalesce(netuid,-1)" ? row.netuid! : row[key]!;
  });
  const calls: { text: string; values: unknown[] }[] = [];
  const scope: PgTransaction = {
    async query<Row>(text: string, values: unknown[] = []): Promise<Row[]> {
      calls.push({ text, values });
      let result: unknown[];
      if (text.startsWith("LOCK TABLE")) result = [];
      else if (text.includes("FROM pg_trigger"))
        result = options.triggers?.(triggers) ?? triggers;
      else if (text.includes("FROM pg_attribute"))
        result = options.columns?.(columns) ?? columns;
      else if (text.includes("WITH page AS MATERIALIZED"))
        result =
          options.payload !== undefined
            ? [{ payload: options.payload }]
            : [
                ...(options.rows ?? [row]).map((value) => ({
                  payload: JSON.stringify(value),
                })),
                ...(options.overflow ? [{ payload: null }] : []),
              ];
      else throw new Error("Unexpected fixture query");
      return result as Row[];
    },
    async first<Row>(
      text: string,
      values: unknown[] = [],
    ): Promise<Row | null> {
      calls.push({ text, values });
      if (text.includes("native_export_revisions"))
        return options.missingRevision
          ? null
          : ({ revision: options.revision ?? "1", day_revision: null } as Row);
      if (text.includes("count(*)::text"))
        return options.count === null
          ? null
          : ({ count: options.count ?? "1" } as Row);
      if (text.includes("SELECT CASE WHEN octet_length(payload)"))
        return {
          payload:
            options.document === undefined
              ? decoder.encode('{"1":{"rank":0.1},"k76":{"rank":0.1}}')
              : options.document,
        } as Row;
      throw new Error("Unexpected fixture singleton");
    },
    async run() {
      throw new Error("Exports must not mutate fixture data");
    },
  };
  const store = createPgStateExport(
    {
      schema: "app",
      access: "read-write",
      relations: ["native_export_revisions", ...sources],
      transaction: async (callback, settings) => {
        expect(settings?.isolation).toBe("read committed");
        return callback(scope);
      },
    },
    {
      ...decoder,
      extract: options.extract ?? decoder.extract,
      numericAffinity: options.numericAffinity ?? decoder.numericAffinity,
    },
    { identity: "urn:metagraphed:export:unit" },
  );
  return {
    row,
    calls,
    store,
    request: (body: Record<string, unknown> = {}) =>
      store.export({
        table,
        kind: "rows",
        columns: [projection[table]![0]![0]],
        ...body,
      }),
  };
}

describe("native export protocol boundaries", () => {
  it("binds projection identities to table plans and cursor implementations", async () => {
    const identity = async (f: ReturnType<typeof fixture>) =>
      (
        await (
          await f.request({ kind: "schema", encoding: "lossless-v1" })
        ).json<UnitReply>()
      ).projection_sha256;
    const original = fixture();
    const baseline = await identity(original);
    expect(await identity(fixture())).toBe(baseline);
    expect(
      await identity(
        fixture({ numericAffinity: (value) => decoder.numericAffinity(value) }),
      ),
    ).not.toBe(baseline);
    const plan = D1_EXPORT_TABLES.account_balances!;
    try {
      D1_EXPORT_TABLES.account_balances = {
        ...plan,
        watermark: ["captured_at"],
      };
      expect(await identity(original)).not.toBe(baseline);
      expect(await identity(fixture())).not.toBe(baseline);
    } finally {
      D1_EXPORT_TABLES.account_balances = plan;
    }
  });

  it("keeps the approved projection synchronized with the pinned source schema", () => {
    expect(exportProjectionSource()).toBe(
      readFileSync(
        new URL("../generated/db/export-projection.ts", import.meta.url),
        "utf8",
      ),
    );
  });

  it("refuses malformed source envelopes and non-text field representations", async () => {
    for (const payload of ["null", "[]", "1", '{"ss58":true}', '{"ss58":{}}'])
      expect((await fixture({ payload }).request()).status).toBe(503);
  });

  it("reads schema/counts, rows and revisions under the same page lock", async () => {
    const f = fixture();
    const schema = await (
      await f.request({ kind: "schema", encoding: "lossless-v1" })
    ).json<UnitReply>();
    expect(schema).toMatchObject({
      version: 1,
      table: "account_balances",
      row_count: 1,
      revision: 1,
      day_revisions: false,
    });
    expect(
      (await (await f.request({ kind: "revision" })).json<UnitReply>())
        .revision,
    ).toBe(1);
    expect((await (await f.request()).json<UnitReply>()).rows).toEqual([
      ["value"],
    ]);
    expect(f.calls[0]!.text).toContain(
      'LOCK TABLE app."account_balances" IN SHARE MODE',
    );
    expect(
      (
        await fixture({ count: "2000001" }).request({
          kind: "schema",
          encoding: "lossless-v1",
        })
      ).status,
    ).toBe(413);
    expect((await fixture({ rows: [] }).request()).status).toBe(200);
  });

  it("never acknowledges absent, malformed or changed revisions", async () => {
    expect((await fixture({ missingRevision: true }).request()).status).toBe(
      503,
    );
    for (const revision of ["-1", "NaN", "9007199254740992"])
      expect((await fixture({ revision }).request()).status).toBe(503);
    expect((await fixture().request({ revision: 2 })).status).toBe(409);
  });

  it("requires current source and closed-day trigger contracts", async () => {
    for (const change of [
      (rows: Trigger[]) => rows.slice(1),
      (rows: Trigger[]) => rows.map((row) => ({ ...row, type: 0 })),
      (rows: Trigger[]) => rows.map((row) => ({ ...row, enabled: "D" })),
      (rows: Trigger[]) => rows.map((row) => ({ ...row, function: "other" })),
      (rows: Trigger[]) => rows.map((row) => ({ ...row, args: "00" })),
    ])
      expect((await fixture({ triggers: change }).request()).status).toBe(503);
    for (const key of ["type", "enabled", "function", "args"] as const)
      expect(
        (
          await fixture({
            table: "subnet_snapshots",
            triggers: (rows) =>
              rows.map((row) =>
                row.name === "native_export_closed_day"
                  ? { ...row, [key]: key === "type" ? 0 : "wrong" }
                  : row,
              ),
          }).request()
        ).status,
      ).toBe(503);
    expect(
      (
        await fixture({
          table: "subnet_snapshots",
          triggers: (rows) =>
            rows.filter((row) => row.name !== "native_export_closed_day"),
        }).request()
      ).status,
    ).toBe(503);
  });

  it("rejects additions, missing columns and incompatible physical types", async () => {
    for (const columns of [
      (rows: Column[]) => [...rows, { name: "unapproved", type: "text" }],
      (rows: Column[]) => rows.slice(1),
      (rows: Column[]) => rows.map((row) => ({ ...row, type: "bytea" })),
    ])
      expect((await fixture({ columns }).request()).status).toBe(503);
    expect(
      (
        await fixture({
          columns: (rows) => [...rows, { name: "_internal", type: "text" }],
        }).request()
      ).status,
    ).toBe(200);
  });

  it("bounds ordinary/lossless data pages and their resumption cursor", async () => {
    const row = {
      ss58: "value",
      free_tao: "0.1",
      reserved_tao: null,
      captured_at: "1",
      _key0: "value",
    };
    const f = fixture({ rows: [row] });
    expect(
      (
        await (
          await f.request({
            columns: ["free_tao", "reserved_tao", "captured_at"],
          })
        ).json<UnitReply>()
      ).rows,
    ).toEqual([[0.1, null, 1]]);
    expect(
      (
        await (
          await f.request({
            columns: ["ss58", "free_tao", "reserved_tao", "captured_at"],
            encoding: "lossless-v1",
          })
        ).json<UnitReply>()
      ).rows[0],
    ).toMatchObject([
      { storage: "text" },
      { storage: "real" },
      { storage: "null" },
      { storage: "integer" },
    ]);
    const large = fixture({
      rows: [{ ...row, ss58: "x".repeat(2 * 1024 * 1024) }],
    });
    expect((await large.request()).status).toBe(413);
    expect((await fixture({ rows: [], overflow: true }).request()).status).toBe(
      413,
    );
    expect(
      (
        await (
          await fixture({ rows: [row], overflow: true }).request()
        ).json<UnitReply>()
      ).next_cursor,
    ).toEqual(["value"]);
    const many = fixture({
      rows: Array.from({ length: 2001 }, (_, index) => ({
        ...row,
        _key0: String(index),
      })),
    });
    const page = await (await many.request()).json<UnitReply>();
    expect(page.rows).toHaveLength(2000);
    expect(page.next_cursor).toEqual(["1999"]);
    expect(
      (
        await fixture({ rows: [{ ...row, _key0: "x".repeat(2049) }] }).request({
          columns: ["ss58", "free_tao", "reserved_tao", "captured_at"],
          encoding: "lossless-v1",
        })
      ).status,
    ).toBe(503);
    expect(
      (
        await fixture({ rows: [{ ...row, _key0: null }] }).request({
          columns: ["ss58", "free_tao", "reserved_tao", "captured_at"],
          encoding: "lossless-v1",
        })
      ).status,
    ).toBe(503);
  });

  it("preserves daily inventory bounds and selected closed-day revisions", async () => {
    const f = fixture({
      table: "subnet_snapshots",
      rows: [{ day: "2020-01-01", rows: "2" }],
    });
    expect(
      (await (await f.request({ kind: "days" })).json<UnitReply>()).days,
    ).toEqual([{ day: "2020-01-01", rows: 2 }]);
    expect(
      (
        await (
          await f.request({
            kind: "revision",
            day: "2020-01-01",
            revision_scope: "day",
          })
        ).json<UnitReply>()
      ).revision,
    ).toBe(0);
    expect(
      (
        await fixture({
          table: "subnet_snapshots",
          rows: [{ day: "x".repeat(2 * 1024 * 1024), rows: "2" }],
        }).request({ kind: "days" })
      ).status,
    ).toBe(413);
    expect(
      (
        await fixture({
          table: "subnet_snapshots",
          rows: [],
          overflow: true,
        }).request({ kind: "days" })
      ).status,
    ).toBe(413);
  });

  it("preserves numeric and raw UTF-8 cursor parameters", async () => {
    for (const cursor of ["2", "2.5", "1e999", "-1e999", "not numeric", 2]) {
      const f = fixture({ table: "account_identity_history", rows: [] });
      expect((await f.request({ cursor: [cursor], revision: 1 })).status).toBe(
        200,
      );
    }
    const f = fixture({ rows: [] });
    await f.request({ cursor: ["a\0\ud800"], revision: 1 });
    expect(
      f.calls.find((call) => call.text.includes("WITH page AS MATERIALIZED"))!
        .values,
    ).toEqual([Buffer.from("a\0\ud800")]);
    const since = fixture({ table: "account_identity_history", rows: [] });
    expect(
      (await since.request({ watermark: ["id"], since: [1] })).status,
    ).toBe(200);
    const empty = fixture({ table: "surface_failure_daily", rows: [] });
    expect(
      (await empty.request({ cursor: ["d", "1", "k", "c"], revision: 1 }))
        .status,
    ).toBe(200);
  });

  it("reads the three original document views with bounded document storage", async () => {
    for (const table of views) {
      const f = fixture({ table });
      expect(
        (await (await f.request({ columns: ["rank"] })).json<UnitReply>()).rows,
      ).toEqual([[0.1]]);
    }
    for (const document of [
      null,
      new Uint8Array(524289),
      new Uint8Array([0xff]),
    ])
      expect(
        (
          await fixture({ table: "neurons", document }).request({
            columns: ["rank"],
          })
        ).status,
      ).toBe(503);
    const rows = Array.from({ length: 19 }, (_, index) => ({
      netuid: String(index),
      uid: "1",
      hotkey: "h",
      coldkey: "c",
      shard: "0",
      _key0: String(index),
      _key1: "1",
    }));
    const f = fixture({
      table: "neurons",
      rows,
      document: decoder.encode(
        JSON.stringify({ "1": { rank: 0.1 }, padding: "x".repeat(500000) }),
      ),
    });
    expect(
      (await (await f.request({ columns: ["rank"] })).json<UnitReply>()).rows,
    ).toHaveLength(19);
    expect(
      f.calls.filter((call) =>
        call.text.includes("SELECT CASE WHEN octet_length(payload)"),
      ).length,
    ).toBe(19);
  });

  it("preserves booleans and non-finite wire numbers, and checks missing censuses", async () => {
    for (const [value, expected] of [
      ["true", 1],
      ["false", 0],
    ] as const) {
      const f = fixture({
        table: "subnet_snapshots",
        rows: [
          {
            netuid: "1",
            emission_enabled: value,
            _key0: "2020-01-01",
            _key1: "1",
          },
        ],
      });
      expect(
        (
          await (
            await f.request({ columns: ["emission_enabled"] })
          ).json<UnitReply>()
        ).rows,
      ).toEqual([[expected]]);
    }
    expect(
      (
        await fixture({
          table: "subnet_snapshots",
          rows: [{ emission_enabled: "bad", _key0: "day", _key1: "1" }],
        }).request({ columns: ["emission_enabled"] })
      ).status,
    ).toBe(503);
    for (const [value, expected] of [
      ["0", 0],
      ["Infinity", null],
    ] as const)
      expect(
        (
          await (
            await fixture({
              rows: [{ free_tao: value, _key0: "key" }],
            }).request({ columns: ["free_tao"] })
          ).json<UnitReply>()
        ).rows,
      ).toEqual([[expected]]);
    for (const count of [null, "NaN", "-1"])
      expect(
        (
          await fixture({ count }).request({
            kind: "schema",
            encoding: "lossless-v1",
          })
        ).status,
      ).toBe(503);
    expect((await fixture().request({ kind: "schema" })).status).toBe(200);
    expect(
      (
        await fixture({ table: "subnet_lifecycle" }).request({
          kind: "schema",
          encoding: "lossless-v1",
        })
      ).status,
    ).toBe(200);
    expect(
      (await fixture({ table: "subnet_lifecycle", rows: [] }).request()).status,
    ).toBe(200);
  });

  it("preserves exact lossless cursors and rejects noncanonical integers", async () => {
    const table = "account_identity_history",
      columns = projection[table]!.map((column) => column[0]);
    for (const cursor of [
      [1],
      ["01"],
      ["-0"],
      ["-9223372036854775809"],
      ["9223372036854775808"],
    ])
      expect(
        (
          await fixture({ table }).request({
            columns,
            encoding: "lossless-v1",
            cursor,
            revision: 1,
          })
        ).status,
      ).toBe(400);
    expect(
      (
        await fixture({ table, rows: [] }).request({
          columns,
          encoding: "lossless-v1",
          cursor: ["0"],
          revision: 1,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fixture({ rows: [] }).request({
          columns: projection["account_balances"]!.map((column) => column[0]),
          encoding: "lossless-v1",
          cursor: ["key"],
          revision: 1,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fixture({ table: "subnet_snapshots", rows: [] }).request({
          day: "2020-01-01",
          cursor: ["2020-01-01", 0],
          revision: 1,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fixture({ table: "subnet_snapshots", rows: [] }).request({
          day: "2020-01-01",
          cursor: ["2020-01-02", 0],
          revision: 1,
        })
      ).status,
    ).toBe(400);
    const textNumber = fixture({ rows: [] });
    expect(
      (await textNumber.request({ cursor: [12], revision: 1 })).status,
    ).toBe(200);
    const keys = { id: "1", _key0: "1" };
    expect(
      (
        await (
          await fixture({ table, rows: [keys], overflow: true }).request({
            columns: ["id"],
          })
        ).json<UnitReply>()
      ).next_cursor,
    ).toEqual([1]);
    for (const value of ["-9223372036854775809", "9223372036854775808"])
      expect(
        (
          await fixture({
            table,
            rows: [{ ...fixture({ table }).row, _key0: value }],
          }).request({ columns, encoding: "lossless-v1" })
        ).status,
      ).toBe(503);
  });

  it("bounds multi-key lossless continuations and preserves document cache hits", async () => {
    const table = "surface_failure_daily",
      text = "\u0800".repeat(2048);
    const row = {
      day: text,
      netuid: "1",
      kind: text,
      classification: text,
      checks: "1",
      updated_at: "1",
      _key0: text,
      _key1: "1",
      _key2: text,
      _key3: text,
    };
    expect(
      (
        await fixture({ table, rows: [row], overflow: true }).request({
          columns: projection[table]!.map((column) => column[0]),
          encoding: "lossless-v1",
        })
      ).status,
    ).toBe(413);
    const cached = fixture({
      table: "neurons",
      rows: [
        {
          netuid: "1",
          uid: "1",
          hotkey: "h",
          coldkey: null,
          shard: "0",
          _key0: "1",
          _key1: "1",
        },
        {
          netuid: "1",
          uid: "2",
          hotkey: "h",
          coldkey: null,
          shard: "0",
          _key0: "1",
          _key1: "2",
        },
      ],
    });
    expect(
      (
        await (
          await cached.request({ columns: ["netuid", "coldkey", "rank"] })
        ).json<UnitReply>()
      ).rows,
    ).toEqual([
      [1, null, 0.1],
      [1, null, null],
    ]);
    expect(
      cached.calls.filter((call) =>
        call.text.includes("SELECT CASE WHEN octet_length(payload)"),
      ).length,
    ).toBe(1);
    const blob = new Uint8Array([0, 255]);
    expect(
      (
        await fixture({ table: "neurons", extract: () => blob }).request({
          columns: ["rank"],
        })
      ).status,
    ).toBe(503);
    const binary = fixture({ table: "neurons", extract: () => blob });
    const result = await (
      await binary.request({
        columns: projection["neurons"]!.map((column) => column[0]),
        encoding: "lossless-v1",
      })
    ).json<UnitReply>();
    expect(result.rows[0]).toContainEqual({ storage: "blob", value: "00FF" });
  });
});
