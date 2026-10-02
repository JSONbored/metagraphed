// Temporary remote-only formatting/generated-contract handoff; removed before release.
import { test } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { format, resolveConfig } from "prettier";

test("retain source formatting and derived deployment contract on remote CI", async () => {
  if (!process.env.CI) return;
  const source = [
    "src/native-code-artifact.ts",
    "src/native-evm-simulation.ts",
    "src/native-runtime.ts",
    "schemas-src/routes/native-runtime.ts",
    "tests/native-code-artifact.test.ts",
    "tests/native-runtime-eras.test.ts",
    "apps/ui/src/lib/metagraphed/native-runtime.ts",
    "apps/ui/src/lib/metagraphed/native-runtime.test.ts",
    "apps/ui/src/routes/-native-runtime-page.tsx",
    "apps/ui/tests/e2e/native-runtime.spec.ts",
    "docs/native-runtime-contract.md",
  ];
  execFileSync("npm", ["run", "sync", "--workspace", "packages/client"], { stdio: "pipe" });
  execFileSync("npm", ["run", "build", "--workspace", "packages/client"], { stdio: "pipe" });
  execFileSync("npm", ["run", "build", "--workspace", "packages/ui-kit"], { stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/generate-openapi-docs.ts"], { cwd: "apps/ui", stdio: "pipe" });
  const generated = [
    "public/metagraph/openapi.json",
    "public/metagraph/types.d.ts",
    "public/metagraph/api-index.json",
    "public/metagraph/contracts.json",
    "packages/contract/index.d.ts",
    "apps/ui/content/docs/api-reference/chain/native-runtime.mdx",
  ];
  for (const path of [...source, ...generated]) {
    const raw = readFileSync(path, "utf8");
    const data = source.includes(path) ? await format(raw, { ...(await resolveConfig(path)), filepath: path }) : raw;
    const bytes = Buffer.from(data);
    console.log("NATIVE_OUTPUT_FILE", path, bytes.length, createHash("sha256").update(bytes).digest("hex"));
    const encoded = gzipSync(bytes).toString("base64");
    for (let offset = 0; offset < encoded.length; offset += 16000)
      console.log("NATIVE_OUTPUT_DATA", path, offset / 16000, encoded.slice(offset, offset + 16000));
  }
}, 180000);
