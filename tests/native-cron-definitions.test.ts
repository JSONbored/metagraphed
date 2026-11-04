import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { test, vi } from "vitest";
import { parseNativeCron } from "../src/native-cron.ts";
vi.resetModules();
const { NATIVE_CRON_DEFINITIONS } =
  await import("../src/native-cron-definitions.ts");

test("native inventory matches every declared Worker schedule without rewriting its string", () => {
  const configs = {
    api: "wrangler.jsonc",
    data: "wrangler.data.jsonc",
    registry: "wrangler.registry.jsonc",
  };
  assert.equal(NATIVE_CRON_DEFINITIONS.length, 36);
  for (const [owner, config] of Object.entries(configs)) {
    const result = ts.parseConfigFileTextToJson(
      config,
      readFileSync(config, "utf8"),
    );
    assert.equal(result.error, undefined);
    const crons = (result.config as { triggers: { crons: string[] } }).triggers
      .crons;
    assert.deepEqual(
      NATIVE_CRON_DEFINITIONS.filter((definition) => definition.owner === owner)
        .map((definition) => definition.cron)
        .sort(),
      crons.sort(),
    );
  }
  for (const definition of NATIVE_CRON_DEFINITIONS) {
    const cron = parseNativeCron(definition.cron);
    assert.ok(cron.window(-1, 86400000 - 1).count > 0);
  }
});
