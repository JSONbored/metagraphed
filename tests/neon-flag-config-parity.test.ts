// Retired connection capabilities must not silently return in one Worker.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripJsonComments } from "../scripts/lib.ts";
import { test } from "vitest";
import { neonWriteBufferEnabled } from "../src/neon-write-buffer.ts";

const CONFIGS = [
  "wrangler.jsonc",
  "wrangler.data.jsonc",
  "wrangler.registry.jsonc",
];
for (const file of CONFIGS) {
  test(`${file} owns state in D1 without any Neon connection, flag or buffer`, () => {
    const config = JSON.parse(
      stripJsonComments(readFileSync(file, "utf8")),
    ) as {
      vars: Record<string, string>;
      hyperdrive?: unknown[];
      durable_objects?: { bindings: { name: string }[] };
      d1_databases?: { binding: string }[];
    };
    assert.deepEqual(config.hyperdrive ?? [], []);
    assert.equal(
      config.durable_objects?.bindings.some(
        (b) => b.name === "NEON_WRITE_BUFFER",
      ) ?? false,
      false,
    );
    assert.deepEqual(
      Object.keys(config.vars).filter((k) => k.startsWith("NEON_")),
      [],
    );
    assert.equal(config.vars.D1_EXPORT_REVISIONS, "enabled");
    assert.ok(config.d1_databases?.some((b) => b.binding === "D1_STATE"));
    const owners = config.vars.D1_STATE_TABLES!.split(",");
    assert.equal(new Set(owners).size, owners.length);
    assert.equal(owners.length, file === "wrangler.registry.jsonc" ? 7 : 71);
    for (const lane of [
      "neurons",
      "account-balances",
      "hotkey-alpha",
      "nominator-positions",
      "tao-usd-index",
    ])
      assert.equal(neonWriteBufferEnabled(config.vars, lane), false);
  });
}
test("both serving Workers declare the same complete D1 family ownership", () => {
  const configs = CONFIGS.slice(0, 2).map((file) =>
    JSON.parse(stripJsonComments(readFileSync(file, "utf8"))),
  );
  assert.deepEqual(
    configs[0].vars.D1_STATE_TABLES.split(",").sort(),
    configs[1].vars.D1_STATE_TABLES.split(",").sort(),
  );
});
