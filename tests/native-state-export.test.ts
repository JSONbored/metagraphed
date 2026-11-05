import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { D1_EXPORT_TABLES } from "../src/d1-export-tables.ts";
import { selectedNativeStateExport } from "../src/native-state-export.ts";
import { createPgStateExport } from "../src/pg-state-export.ts";
import { createSqliteDocumentDecoder } from "../src/sqlite-document-decoder.ts";
import { exportProjectionSource } from "../scripts/generate-export-projection.ts";

describe("native export selection and policy", () => {
  it("keeps the committed metadata derived from the pinned source schema", () => {
    expect(
      readFileSync(
        new URL("../generated/db/export-projection.ts", import.meta.url),
        "utf8",
      ),
    ).toBe(exportProjectionSource());
  });

  it("requires an explicit complete native capability", () => {
    for (const env of [undefined, null, false, {}, { other: {} }])
      expect(selectedNativeStateExport(env)).toBeNull();
    for (const value of [null, false, {}, { export: false }])
      expect(() =>
        selectedNativeStateExport({ NATIVE_STATE_EXPORT: value }),
      ).toThrow("incomplete");
    const value = { export: async () => new Response() };
    expect(selectedNativeStateExport({ NATIVE_STATE_EXPORT: value })).toBe(
      value,
    );
  });

  it("validates the full source and refuses malformed requests without querying", async () => {
    const relations = [
      "native_export_revisions",
      ...Object.keys(D1_EXPORT_TABLES).flatMap((name) =>
        ["neurons", "neuron_daily", "account_position_daily"].includes(name)
          ? [name + "_members", name + "_documents"]
          : [name],
      ),
    ];
    const decoder = createSqliteDocumentDecoder({ maxAuditBytes: 524288 });
    let calls = 0;
    const source = {
      schema: "app",
      access: "read-write" as const,
      relations,
      transaction: async () => {
        calls++;
        throw new Error("fixture storage unavailable");
      },
    };
    try {
      for (const changed of [
        { schema: "wrong" },
        { relations: [] },
        { access: "wrong" as "read" },
      ])
        expect(() =>
          createPgStateExport({ ...source, ...changed }, decoder, {
            identity: "urn:metagraphed:export:test",
          }),
        ).toThrow("ownership");
      expect(() =>
        createPgStateExport(source, decoder, { identity: "wrong" }),
      ).toThrow("identity");
      const store = createPgStateExport(source, decoder, {
        identity: "urn:metagraphed:export:test",
      });
      const base = {
        table: "account_balances",
        kind: "rows",
        columns: ["ss58"],
      };
      for (const input of [
        null,
        {},
        { ...base, extra: true },
        { ...base, table: "__proto__" },
        { ...base, columns: ["private"] },
        { ...base, columns: ["ss58", "ss58"] },
        { ...base, columns: undefined },
        { ...base, kind: "days" },
        { ...base, day: "2020-01-01" },
        { ...base, cursor: ["x"] },
        { ...base, revision: 1, cursor: ["x", "y"] },
        { ...base, watermark: ["ss58"], since: [1] },
        { ...base, since: [1] },
        { ...base, encoding: "lossless-v1", columns: ["ss58"] },
        { ...base, encoding: "lossless-v1", kind: "days" },
        { ...base, encoding: "lossless-v1", day: "2020-01-01" },
        { ...base, revision_scope: "day" },
        {
          ...base,
          table: "subnet_snapshots",
          day: "9999-01-01",
          revision_scope: "day",
        },
      ])
        expect((await store.export(input)).status).toBe(400);
      expect(calls).toBe(0);
      expect((await store.export(base)).status).toBe(503);
      expect(calls).toBe(1);
    } finally {
      decoder.close();
    }
  });
});
