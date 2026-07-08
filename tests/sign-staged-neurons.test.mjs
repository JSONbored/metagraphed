import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";

test("sign-staged-neurons.mjs signs expected_netuid_count on hyperparams payloads", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sign-hyperparams-"));
  const input = path.join(dir, "in.json");
  const output = path.join(dir, "out.json");
  const captured_at = 1_750_000_000_000;
  writeFileSync(
    input,
    JSON.stringify({
      rows: [{ netuid: 1, tempo: 360 }],
      expected_netuid_count: 1,
      captured_at,
    }),
  );
  execFileSync(
    process.execPath,
    ["scripts/sign-staged-neurons.mjs", input, output],
    {
      env: { ...process.env, METAGRAPH_STAGING_SIGNING_KEY: "test-sign-key" },
    },
  );
  const envelope = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(envelope.schema_version, 1);
  assert.equal(envelope.expected_netuid_count, 1);
  assert.equal(envelope.captured_at, captured_at);
  assert.match(envelope.hmac_sha256, /^[a-f0-9]{64}$/);
  const payload = JSON.stringify({
    rows: envelope.rows,
    captured_at,
    expected_netuid_count: 1,
  });
  assert.equal(
    envelope.hmac_sha256,
    createHmac("sha256", "test-sign-key").update(payload).digest("hex"),
  );
});
