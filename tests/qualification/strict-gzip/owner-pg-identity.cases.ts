import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { OWNER_PG_SOURCES, assertOwnerPgSource } from "./owner-pg-identity.ts";
const data = JSON.parse(
  readFileSync(
    new URL("./owner-pg-source-fixtures.json", import.meta.url),
    "utf8",
  ),
);
for (const relative of Object.keys(OWNER_PG_SOURCES)) {
  test(`exact inert public source identity: ${relative}`, () =>
    assertOwnerPgSource(relative, data[relative]));
  test(`changed driver source refused: ${relative}`, () =>
    assert.throws(() => assertOwnerPgSource(relative, data[relative] + " ")));
}
test("empty default Cloudflare transport cannot replace actual socket implementation", () =>
  assert.throws(() =>
    assertOwnerPgSource("pg-cloudflare/src/index.ts", "module.exports = {}"),
  ));
test("compiled fallback name does not satisfy chained source identity", () =>
  assert.throws(() => assertOwnerPgSource("pg-cloudflare/dist/empty.js", "")));
test("source fixtures are data only with exact fixed inventory", () =>
  assert.deepEqual(
    Object.keys(data).sort(),
    Object.keys(OWNER_PG_SOURCES).sort(),
  ));
