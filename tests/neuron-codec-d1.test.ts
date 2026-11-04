import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "vitest";
import { Miniflare } from "miniflare";
import { createSqliteDocumentDecoder } from "../src/sqlite-document-decoder.ts";

const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('fixture')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
const decoder = createSqliteDocumentDecoder({ maxAuditBytes: 1024 });
let db: D1Database;
beforeAll(async () => {
  db = await runtime.getD1Database("DB");
});
afterAll(async () => {
  decoder.close();
  await runtime.dispose();
});

test("SQL scalar text and keys use the actual D1 UTF-8 wire replacement without altering source bytes", async () => {
  for (const escaped of [
    "\\ud800",
    "\\udc00",
    "\\ud800x\\udc00",
    "a\\u0000b",
    "\\ud83d\\ude00",
  ]) {
    const json = `{"row":{"axon":"${escaped}"}}`;
    const bytes = decoder.encode(json),
      original = bytes.slice();
    const expected = await db
      .prepare("SELECT json_extract(jsonb(?), '$.row.axon') AS value")
      .bind(json)
      .first<{ value: string }>();
    assert.equal(decoder.extract(bytes, "$.row.axon"), expected!.value);
    assert.equal(decoder.axons(bytes)[0].value, expected!.value);
    assert.equal(
      decoder.metricEntries(bytes, ["axon"])[0].values.axon,
      expected!.value,
    );
    assert.equal(decoder.entries(bytes, "$.row")[0].value, expected!.value);
    assert.deepEqual(bytes, original);
    assert.equal(decoder.decode(bytes), json);
    const keyed = `{"${escaped}":{"axon":1}}`;
    const key = (await db
      .prepare("SELECT key FROM json_each(jsonb(?))")
      .bind(keyed)
      .first<{ key: string }>())!.key;
    const payload = decoder.encode(keyed);
    assert.equal(decoder.entries(payload)[0].key, key);
    assert.equal(decoder.metricEntries(payload, [])[0].key, key);
    assert.equal(decoder.axons(payload)[0].key, key);
  }
  const malformed = new Uint8Array([0x17, 0xff]);
  const expected = await db
    .prepare("SELECT json_extract(?, '$') AS value")
    .bind(malformed)
    .first<{ value: string }>();
  assert.equal(decoder.extract(malformed, "$"), expected!.value);
  assert.throws(() => decoder.decode(malformed));
});

test("optional original TEXT bytes preserve SQLite MAX order before wire replacement", async () => {
  const json = '{"0":{"axon":"\\ud800"},"1":{"axon":"\\ue000"}}';
  const payload = decoder.encode(json);
  const rows = decoder.metricEntries(
    payload,
    ["axon", "missing"],
    undefined,
    true,
  );
  const expected = await db
    .prepare(
      "SELECT max(json_extract(value,'$.axon')) AS value FROM json_each(jsonb(?))",
    )
    .bind(json)
    .first<{ value: string }>();
  rows.sort((left, right) =>
    Buffer.compare(left.textBytes!.axon, right.textBytes!.axon),
  );
  assert.equal(rows.at(-1)!.values.axon, expected!.value);
  assert.equal(expected!.value, "\ue000");
  assert.deepEqual([...rows[0].textBytes!.axon], [0xed, 0xa0, 0x80]);
  assert.equal(rows[0].values.axon, "\ufffd\ufffd\ufffd");
  assert.equal(rows[0].textBytes!.missing, undefined);
  assert.equal(
    decoder.metricEntries(payload, ["axon"])[0].textBytes,
    undefined,
  );
});
