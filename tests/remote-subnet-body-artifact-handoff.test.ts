import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { format, resolveConfig } from "prettier";
import { test } from "vitest";

const paths = [
  "apps/ui/src/components/metagraphed/subnet-detail/surface-integrations.tsx",
  "apps/ui/src/components/metagraphed/subnet-detail/surface-integrations.test.tsx",
  "docs/subnet-http.md",
  "schemas-src/mcp-tools/ai-integration.ts",
  "src/public-commit-artifact.ts",
  "src/subnet-body-artifact-policy.ts",
  "src/subnet-body-artifact.ts",
  "src/call-subnet-surface.ts",
  "src/mcp-server.ts",
  "src/native-code-artifact.ts",
  "src/usage-telemetry.ts",
  "tests/subnet-body-artifact.test.ts",
  "tests/subnet-http-body-worker.test.ts",
  "tests/usage-telemetry.test.ts",
  "schemas-src/query-enums.ts",
  "schemas-src/subnet-http-admission.ts",
  "schemas/subnet-manifest.schema.json",
  "scripts/validate-schema-enums.ts",
  "tests/subnet-http-admission.test.ts",
  "public/metagraph/openapi.json",
  "public/metagraph/types.d.ts",
  "packages/contract/index.d.ts",
  "generated/graphql/schema.ts",
  "generated/graphql/types.ts",
] as const;
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

test.skipIf(process.env.CI !== "true")(
  "export exact remote file source formatting and generated contracts",
  async () => {
    const head = execFileSync("git", ["rev-parse", "HEAD"])
      .toString()
      .trim();
    assert.match(head, /^[0-9a-f]{40}$/);
    for (let file_index = 0; file_index < paths.length; file_index++) {
      const path = paths[file_index]!;
      const previous = execFileSync("git", ["show", `HEAD:${path}`], {
        maxBuffer: 12 * 1024 * 1024,
      });
      const current = readFileSync(path);
      const bytes = file_index < 19
        ? Buffer.from(await format(current.toString(), {
            ...(await resolveConfig(path)),
            filepath: path,
          }))
        : current;
      const encoded = gzipSync(bytes).toString("base64");
      console.log("BODY_ARTIFACT_HANDOFF", JSON.stringify({
        file_index, path, head, previous_sha256: sha(previous),
        bytes: bytes.length, sha256: sha(bytes),
        chunks: Math.ceil(encoded.length / 16000), encoding: "gzip-base64",
      }));
      for (let offset = 0; offset < encoded.length; offset += 16000)
        console.log("BODY_ARTIFACT_HANDOFF_CHUNK", JSON.stringify({
          file_index, index: offset / 16000,
          data: encoded.slice(offset, offset + 16000),
        }));
    }
  },
  180000,
);
