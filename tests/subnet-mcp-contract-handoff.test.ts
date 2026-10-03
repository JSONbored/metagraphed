import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { format, resolveConfig } from "prettier";
import { test } from "vitest";

// Temporary remote-only handoff: existing CI builds the canonical artifacts.
// No repository writes, new workflow, deployment or external requests.
test.skipIf(process.env.GITHUB_EVENT_NAME !== "workflow_dispatch")(
  "handoff canonical reviewed HTTP artifacts from the exact CI checkout",
  async () => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const run_id = process.env.GITHUB_RUN_ID;
    assert.match(head, /^[a-f0-9]{40}$/);
    assert.match(run_id ?? "", /^\d+$/);
    const paths = [
      "docs/subnet-http.md",
      "registry/subnets/swap.json",
      "registry/subnets/gopher.json",
      "schemas-src/subnet-http-admission.ts",
      "schemas-src/routes/subnet-detail.ts",
      "schemas-src/routes/agent-catalog.ts",
      "schemas-src/graphql/published-names.ts",
      "schemas-src/mcp-tools/ai-integration.ts",
      "schemas/subnet-manifest.schema.json",
      "scripts/build-artifacts.ts",
      "src/mcp-server.ts",
      "src/subnet-http-admission.ts",
      "tests/subnet-http-admission.test.ts",
      "tests/swap-call-subnet-surface-verify.test.ts",
      "tests/sn42-call-subnet-surface-verify.test.ts",
      "tests/subnet-mcp-contract-handoff.test.ts",
      "apps/ui/src/components/metagraphed/subnet-detail/surfaces.tsx",
      "apps/ui/src/components/metagraphed/subnet-detail/surface-integrations.tsx",
      "apps/ui/src/components/metagraphed/subnet-detail/surface-integrations.test.tsx",
      "apps/ui/tests/e2e/surface-integrations.spec.ts",
      "generated/metagraphed-client.ts",
      "generated/graphql/schema.ts",
      "generated/graphql/types.ts",
      "packages/contract/index.d.ts",
      "public/metagraph/contracts.json",
      "public/metagraph/openapi.json",
      "public/metagraph/types.d.ts",
    ];
    const hash = (bytes: Buffer) =>
      createHash("sha256").update(bytes).digest("hex");
    console.log("MCP_CAPABILITY_HANDOFF_START", JSON.stringify({ head, run_id, files: paths.length }));
    for (const path of paths) {
      const previous = execFileSync("git", ["show", `HEAD:${path}`], {
        maxBuffer: 8 * 1024 * 1024,
      });
      const source = readFileSync(path, "utf8");
      const generated = path.startsWith("generated/") ||
        path.startsWith("public/metagraph/") ||
        path === "packages/contract/index.d.ts";
      const bytes = Buffer.from(generated ? source : await format(source, {
        ...(await resolveConfig(path)),
        filepath: path,
      }));
      assert.ok(bytes.length <= 8 * 1024 * 1024);
      const data = gzipSync(bytes).toString("base64");
      const chunks = Math.ceil(data.length / 3000);
      console.log("MCP_CAPABILITY_HANDOFF_FILE", JSON.stringify({
        head, run_id, path, bytes: bytes.length, sha256: hash(bytes),
        previous_sha256: hash(previous), chunks, encoding: "gzip-base64",
      }));
      for (let index = 0; index < chunks; index++)
        console.log("MCP_CAPABILITY_HANDOFF_CHUNK", JSON.stringify({
          path, index, data: data.slice(index * 3000, (index + 1) * 3000),
        }));
    }
    console.log("MCP_CAPABILITY_HANDOFF_END", JSON.stringify({ head, run_id, files: paths.length }));
  },
  120_000,
);
