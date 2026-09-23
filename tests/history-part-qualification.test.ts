import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { main, qualifyHistoryPart } from "../scripts/qualify-history-part.ts";

function identity(bytes: Uint8Array, rows = 10) {
  return {
    key: "history/part.parquet",
    etag: createHash("md5").update(bytes).digest("hex"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
    rows,
  };
}

test("native part qualification preserves wide integers and bounded point reads", async () => {
  const bytes = await readFile(
    "tests/fixtures/parquet/history-events-0.parquet",
  );
  const result = await qualifyHistoryPart(bytes, identity(bytes));
  assert.equal(result.index.rows, 10);
  assert.deepEqual(
    result.points.map((point) => point.row),
    [0, 5, 9],
  );
  for (const point of result.points) {
    assert.equal(point.rows.length, 1);
    assert.equal(point.rows[0].wide, 9007199254740992n + BigInt(point.row));
    assert.equal(point.rows[0].nullable, point.row % 2 === 0 ? "value" : null);
    assert.ok(
      point.budget.bytes > 0 && point.budget.bytes <= point.budget.maxBytes,
    );
    assert.ok(
      point.budget.requests > 0 &&
        point.budget.requests <= point.budget.maxRequests,
    );
  }
});

test("qualification refuses changed bytes, malformed identity, census drift and oversized groups", async () => {
  const bytes = await readFile(
    "tests/fixtures/parquet/history-events-0.parquet",
  );
  const part = identity(bytes);
  for (const change of [
    { bytes: part.bytes + 1 },
    { etag: "0".repeat(32) },
    { sha256: "0".repeat(64) },
    { rows: 11 },
    { rows: 0 },
    { rows: 65_537 },
    { bytes: 128 * 1024 * 1024 + 1 },
    { extra: "unrecognized" },
  ])
    await assert.rejects(qualifyHistoryPart(bytes, { ...part, ...change }));
  const malformed = Buffer.from(bytes);
  malformed[malformed.length - 1] = 0;
  await assert.rejects(
    qualifyHistoryPart(malformed, identity(malformed)),
    /footer/,
  );
  const largeGroups = await readFile(
    "tests/fixtures/parquet/flat-v1-zstd.parquet",
  );
  await assert.rejects(
    qualifyHistoryPart(largeGroups, identity(largeGroups, 2000)),
    /row-group/,
  );
});

test("CLI reads a pinned local part and emits exact JSON only after qualification", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "history-part-proof-"));
  try {
    const bytes = await readFile(
      "tests/fixtures/parquet/history-events-0.parquet",
    );
    const partPath = path.join(directory, "part.parquet");
    const identityPath = path.join(directory, "identity.json");
    await writeFile(partPath, bytes);
    await writeFile(identityPath, JSON.stringify(identity(bytes)));
    const output = JSON.parse(await main([partPath, identityPath]));
    assert.equal(output.points[0].rows[0].wide, "9007199254740992");
    assert.equal(output.index.key, "history/part.parquet");
    await assert.rejects(main([]), /Usage/);
    await writeFile(partPath, bytes.subarray(1));
    await assert.rejects(main([partPath, identityPath]), /file size/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
