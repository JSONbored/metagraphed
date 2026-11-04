import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { createPgRawCapture } from "../src/pg-raw-capture.ts";
import { selectedNativeRawCapture } from "../src/native-raw-capture.ts";
import { prepareRawCapture } from "../src/raw-capture-object.ts";
import { neonWatermark, runRawCaptureSync } from "../src/raw-capture-sync.ts";
import type { NativeSource } from "../src/native-api-process.ts";
import type { PgTransaction } from "../src/pg-pool.ts";

const key = "chain/raw/blocks/000000000010-000000000010.ndjson";
const value =
  JSON.stringify({
    block_number: 10,
    captured_at: 1000,
    extrinsics: ["0x123"],
  }) + "\n";
const prepared = prepareRawCapture(key, value);
const tables = [
  "raw_capture_budget",
  "raw_capture_batches",
  "raw_capture_chunks",
  "raw_capture_selected",
  "raw_capture_archives",
  "raw_capture_state",
];

function fixture(raw = value) {
  const prepared = prepareRawCapture(key, raw);
  const calls: string[] = [];
  const state = {
    budget: { bytes: "0", objects: "0" } as {
      bytes: string;
      objects: string;
    } | null,
    archived: null as object | null,
    reservation: prepared.descriptor as object | null,
    rows: Array.from({ length: prepared.parts }, (_, part) => ({
      part: String(part),
      data: prepared.compressed.subarray(part * 65536, (part + 1) * 65536),
    })) as {
      part: string;
      data: Buffer;
    }[],
    digest: prepared.digest as string | null,
    watermark: null as string | number | null,
    failedSql: "",
    failedCommit: false,
    ignoreWatermark: false,
    paginate: false,
  };
  const scope: PgTransaction = {
    async run(sql, values = []) {
      calls.push(sql);
      if (state.failedSql && sql.includes(state.failedSql))
        throw new Error("fixture write failed");
      if (
        sql.startsWith("INSERT INTO raw_capture_state") &&
        !state.ignoreWatermark
      )
        state.watermark = String(
          Math.max(Number(state.watermark ?? -1), Number(values[1])),
        );
      return { changes: 1 };
    },
    async query<Row>(sql: string, values: unknown[] = []) {
      calls.push(sql);
      return (
        state.paginate
          ? state.rows.filter(
              (row) =>
                Number(row.part) >= Number(values[2]) &&
                Number(row.part) < Number(values[3]),
            )
          : state.rows
      ) as Row[];
    },
    async first<Row>(sql: string) {
      calls.push(sql);
      let result: object | null;
      if (sql.includes("FROM raw_capture_budget")) result = state.budget;
      else if (sql.includes("SELECT * FROM raw_capture_archives"))
        result = state.archived;
      else if (sql.includes("FROM raw_capture_batches"))
        result = state.reservation;
      else if (sql.includes("FROM raw_capture_state"))
        result =
          state.watermark === null
            ? null
            : { last_contiguous_block: state.watermark };
      else result = state.digest === null ? null : { sha256: state.digest };
      return result as Row | null;
    },
  };
  const source: Pick<NativeSource, "relations" | "access" | "transaction"> = {
    relations: tables,
    access: "read-write",
    async transaction(callback, options) {
      expect(options?.isolation ?? "read committed").toBe("read committed");
      const result = await callback(scope);
      if (state.failedCommit) throw new Error("fixture commit outcome unknown");
      return result;
    },
  };
  return {
    calls,
    state,
    source,
    binding: createPgRawCapture(source, () => 1234),
  };
}

describe("native raw capture", () => {
  test("construction is inert and requires all writable source relations", () => {
    const f = fixture();
    expect(f.calls).toEqual([]);
    expect(() => createPgRawCapture({ ...f.source, access: "read" })).toThrow(
      "writable",
    );
    expect(() =>
      createPgRawCapture({ ...f.source, relations: tables.slice(1) }),
    ).toThrow("complete");
  });

  test("selection keeps bytes and watermark together and never falls back", async () => {
    const f = fixture();
    expect(selectedNativeRawCapture({})).toBeUndefined();
    expect(() =>
      selectedNativeRawCapture({ RAW_CAPTURE_STORAGE: "postgresql" }),
    ).toThrow("unavailable");
    for (const binding of [null, {}, { store: {} }, { store: { put() {} } }])
      expect(() =>
        selectedNativeRawCapture({
          RAW_CAPTURE_STORAGE: "postgresql",
          NATIVE_RAW_CAPTURE: binding,
        }),
      ).toThrow("invalid");
    expect(() =>
      selectedNativeRawCapture({
        RAW_CAPTURE_STORAGE: "d1",
        NATIVE_RAW_CAPTURE: f.binding,
      }),
    ).toThrow("invalid");
    const env = {
      RAW_CAPTURE_STORAGE: "postgresql",
      NATIVE_RAW_CAPTURE: f.binding,
    };
    expect(selectedNativeRawCapture(env)).toBe(f.binding);
    const selectedWatermark = neonWatermark(
      env as never,
      undefined,
      "mainnet",
      () => 0,
    );
    await selectedWatermark.write(20);
    expect(await selectedWatermark.read()).toBe(20);
  });

  test("capture verifies stored chunks and selected receipt before acknowledgment", async () => {
    const f = fixture();
    await f.binding.store.put(key, value);
    expect(f.calls[0]).toContain("pg_advisory_xact_lock");
    expect(f.calls.some((sql) => sql.includes("SET complete=true"))).toBe(true);
    expect(f.calls.at(-1)).toContain("AS selected_capture");
  });

  test("an archived capture needs its exact descriptor and currently selected digest", async () => {
    const f = fixture();
    f.state.archived = {
      ...prepared.descriptor,
      complete: true,
      native_sha256: prepared.compressedDigest,
      native_key: `chain/raw/native/v1/mainnet/${prepared.digest}/${prepared.compressedDigest}.gz`,
    };
    await f.binding.store.put(key, value);
    expect(f.calls.some((sql) => sql.startsWith("INSERT"))).toBe(false);
    f.state.archived = { ...f.state.archived, complete: false };
    await expect(f.binding.store.put(key, value)).rejects.toThrow(
      "archive identity",
    );
  });

  test("absent budget, changed reservation, corrupt chunks and stale selection cannot acknowledge", async () => {
    const f = fixture();
    f.state.budget = null;
    await expect(f.binding.store.put(key, value)).rejects.toThrow("budget");
    f.state.budget = { bytes: "0", objects: "0" };
    f.state.reservation = null;
    await expect(f.binding.store.put(key, value)).rejects.toThrow(
      "reservation",
    );
    f.state.reservation = prepared.descriptor;
    f.state.rows = [];
    await expect(f.binding.store.put(key, value)).rejects.toThrow("chunk");
    f.state.rows = [{ part: "1", data: prepared.compressed }];
    await expect(f.binding.store.put(key, value)).rejects.toThrow("chunk");
    f.state.rows = [{ part: "0", data: Buffer.from("bad") }];
    await expect(f.binding.store.put(key, value)).rejects.toThrow("chunk");
    f.state.rows = [{ part: "0", data: prepared.compressed }];
    f.state.digest = null;
    await expect(f.binding.store.put(key, value)).rejects.toThrow("selection");
  });

  test("storage and commit failures propagate without an internal write retry", async () => {
    const f = fixture();
    f.state.failedSql = "INSERT INTO raw_capture_chunks";
    await expect(f.binding.store.put(key, value)).rejects.toThrow(
      "fixture write failed",
    );
    expect(
      f.calls.filter((sql) => sql.includes(f.state.failedSql)),
    ).toHaveLength(1);
    f.state.failedSql = "";
    f.state.failedCommit = true;
    await expect(f.binding.store.put(key, value)).rejects.toThrow(
      "commit outcome unknown",
    );
  });

  test("watermark reads and writes share the source, remain monotonic and require readback", async () => {
    const f = fixture();
    expect(() => f.binding.watermark("other")).toThrow("network");
    const watermark = f.binding.watermark("mainnet");
    expect(await watermark.read()).toBeNull();
    await watermark.write(10);
    await watermark.write(9);
    expect(await watermark.read()).toBe(10);
    for (const value of [-1, 0.5, Infinity])
      await expect(watermark.write(value)).rejects.toThrow("Invalid");
    f.state.ignoreWatermark = true;
    await expect(watermark.write(20)).rejects.toThrow("not committed");
    f.state.watermark = "9007199254740993";
    await expect(watermark.read()).rejects.toThrow("safe range");
    f.state.watermark = "invalid";
    await expect(watermark.read()).rejects.toThrow("invalid");
  });

  test("invalid capture input is rejected before opening a transaction", async () => {
    const f = fixture();
    await expect(f.binding.store.put("bad", value)).rejects.toThrow("Invalid");
    expect(f.calls).toEqual([]);
  });

  test("large captures use bounded chunk windows", async () => {
    const raw =
      JSON.stringify({
        block_number: 10,
        captured_at: 1000,
        extrinsics: ["0x" + randomBytes(600000).toString("hex")],
      }) + "\n";
    const f = fixture(raw);
    f.state.paginate = true;
    await f.binding.store.put(key, raw);
    expect(
      f.calls.filter((sql) => sql.startsWith("INSERT INTO raw_capture_chunks"))
        .length,
    ).toBeGreaterThan(1);
  });

  test("invalid budgets, descriptor values and binary readbacks decline before selection", async () => {
    const f = fixture();
    for (const budget of [
      { bytes: "-1", objects: "0" },
      { bytes: "536870913", objects: "0" },
      { bytes: "0", objects: "-1" },
      { bytes: "0", objects: "16385" },
    ]) {
      f.state.budget = budget;
      await expect(f.binding.store.put(key, value)).rejects.toThrow("budget");
    }
    f.state.budget = { bytes: "0", objects: "0" };
    for (const reservation of [
      { ...prepared.descriptor, key: "wrong" },
      { ...prepared.descriptor, captured_at: "999" },
    ]) {
      f.state.reservation = reservation;
      await expect(f.binding.store.put(key, value)).rejects.toThrow(
        "reservation",
      );
    }
    f.state.reservation = { ...prepared.descriptor, captured_at: "invalid" };
    await expect(f.binding.store.put(key, value)).rejects.toThrow(
      "integer is invalid",
    );
    f.state.reservation = prepared.descriptor;
    f.state.rows = [
      { part: "0", data: new Uint8Array(prepared.compressed) as Buffer },
    ];
    await expect(f.binding.store.put(key, value)).rejects.toThrow("chunk");
  });

  test("wrong archived source details and invalid clocks cannot advance", async () => {
    const f = fixture();
    const archived = {
      ...prepared.descriptor,
      complete: true,
      native_sha256: prepared.compressedDigest,
      native_key: `chain/raw/native/v1/mainnet/${prepared.digest}/${prepared.compressedDigest}.gz`,
    };
    for (const changed of [
      { ...archived, captured_at: 99 },
      { ...archived, native_sha256: "wrong" },
      { ...archived, native_key: "wrong" },
    ]) {
      f.state.archived = changed;
      await expect(f.binding.store.put(key, value)).rejects.toThrow(
        "archive identity",
      );
    }
    const badClock = createPgRawCapture(f.source, () => NaN).watermark(
      "mainnet",
    );
    await expect(badClock.write(1)).rejects.toThrow("Invalid");
    const negativeClock = createPgRawCapture(f.source, () => -1).watermark(
      "mainnet",
    );
    await expect(negativeClock.write(1)).rejects.toThrow("Invalid");
  });

  test("selected incomplete storage reports an unavailable lane without trying legacy storage", async () => {
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await runRawCaptureSync(
        { RAW_CAPTURE_ENABLED: "true", RAW_CAPTURE_STORAGE: "postgresql" },
        { recordException: async () => false },
      );
      expect(result.reason).toBe("store_unavailable");
    } finally {
      report.mockRestore();
    }
  });
});
