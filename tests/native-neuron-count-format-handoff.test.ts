import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { format, resolveConfig } from "prettier";
import { test } from "vitest";

const paths = [
  "apps/ui/src/lib/metagraphed/native-runtime.ts",
  "apps/ui/src/lib/metagraphed/native-runtime.test.ts",
  "apps/ui/src/routes/-native-runtime-page.tsx",
  "apps/ui/tests/e2e/native-runtime.spec.ts",
  "docs/native-runtime-contract.md",
] as const;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
test("export exact remote neuron count source formatting", async () => {
  assert.equal(process.env.CI, "true");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      env,
      maxBuffer: 2_000_000,
    });
  const head = git(["rev-parse", "HEAD"]).toString().trim();
  assert.match(head, /^[0-9a-f]{40}$/);
  const run_id = Number(process.env.GITHUB_RUN_ID);
  assert.ok(Number.isSafeInteger(run_id) && run_id > 0);
  for (let file_index = 0; file_index < paths.length; file_index++) {
    const path = paths[file_index]!;
    const previous = git(["show", `HEAD:${path}`]);
    const bytes = Buffer.from(
      await format(readFileSync(path).toString(), {
        ...(await resolveConfig(path)),
        filepath: path,
      }),
    );
    const encoded = gzipSync(bytes).toString("base64");
    console.log("NATIVE_NEURON_COUNT_HANDOFF", JSON.stringify({
      file_index, path, head, run_id, previous_sha256: sha(previous),
      bytes: bytes.length, sha256: sha(bytes), chunks: Math.ceil(encoded.length / 8000), encoding: "gzip-base64",
    }));
    for (let offset = 0; offset < encoded.length; offset += 8000)
      console.log("NATIVE_NEURON_COUNT_HANDOFF_CHUNK", JSON.stringify({
        file_index, index: offset / 8000, data: encoded.slice(offset, offset + 8000),
      }));
  }
}, 180_000);
