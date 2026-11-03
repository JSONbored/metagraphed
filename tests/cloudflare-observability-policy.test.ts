import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import { cloudflareObservabilityErrors } from "../scripts/cloudflare-observability-policy.ts";
import { stripJsonComments } from "../scripts/lib.ts";

function mainConfig() {
  return JSON.parse(stripJsonComments(readFileSync("wrangler.jsonc", "utf8")));
}

describe("Cloudflare telemetry ingestion stays disabled", () => {
  for (const file of [
    "wrangler.jsonc",
    "wrangler.data.jsonc",
    "wrangler.registry.jsonc",
    "wrangler.wss-lb.jsonc",
    "apps/ui/wrangler.jsonc",
  ]) {
    test(file, () => {
      const config = JSON.parse(stripJsonComments(readFileSync(file, "utf8")));
      assert.deepEqual(cloudflareObservabilityErrors(config), []);
    });
  }

  test("the trusted preview generator has the same disabled policy", () => {
    const action = readFileSync(
      ".github/actions/deploy-ui-preview/action.yml",
      "utf8",
    );
    const match = action.match(/<<'JSON'\n([\s\S]*?)\n\s*JSON\n/);
    assert.ok(match, "trusted preview JSON must exist");
    assert.deepEqual(cloudflareObservabilityErrors(JSON.parse(match[1]!)), []);
  });

  test("omitted defaults and a retained export destination fail the policy", () => {
    assert.equal(cloudflareObservabilityErrors({}).length, 13);
    const config = mainConfig();
    config.observability.logs.destinations = ["unwanted-export"];
    assert.deepEqual(cloudflareObservabilityErrors(config), [
      "observability.logs.destinations must be an explicit empty array",
    ]);
  });

  test("environment overrides cannot turn ingestion back on", () => {
    const config = mainConfig();
    config.env = { preview: { logpush: true } };
    assert.deepEqual(cloudflareObservabilityErrors(config), [
      "env.preview: logpush must be explicitly false",
    ]);
    config.env.preview = { vars: { EXAMPLE: "value" } };
    assert.deepEqual(cloudflareObservabilityErrors(config), []);
  });

  test("newer issue capture settings cannot opt back into ingestion", () => {
    const config = mainConfig();
    config.observability.issues = { enabled: true };
    assert.deepEqual(cloudflareObservabilityErrors(config), [
      "observability.issues.enabled must not be true",
    ]);
  });
});
