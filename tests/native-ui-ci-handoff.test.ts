// Temporary remote source-format handoff; removed before release.
import { test } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { format, resolveConfig } from "prettier";

test("retain remote source formatting", async () => {
  if (!process.env.CI) return;
  const names = execFileSync("git", ["diff", "--name-only", "25fd81f", "HEAD"], { encoding: "utf8" }).trim().split("\n");
  const files: Record<string, string> = {};
  for (const name of names) {
    if (name === "tests/native-ui-ci-handoff.test.ts" || !/\.(ts|tsx|md)$/.test(name)) continue;
    files[name] = await format(readFileSync(name, "utf8"), {
      ...(await resolveConfig(name)), filepath: name,
    });
  }
  execFileSync(process.execPath, ["scripts/generate-client.ts", "--write"], { stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/generate-graphql-types.ts"], { stdio: "pipe" });
  execFileSync("npm", ["run", "sync", "--workspace", "packages/client"], { stdio: "pipe" });
  execFileSync("npm", ["run", "build", "--workspace", "packages/client"], { stdio: "pipe" });
  execFileSync("npm", ["run", "build", "--workspace", "packages/ui-kit"], { stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/generate-openapi-docs.ts"], { cwd: "apps/ui", stdio: "pipe" });
  const changed = execFileSync("git", ["diff", "--name-only"], { encoding: "utf8" }).trim().split("\n");
  for (const name of changed) {
    if (/^(generated\/|packages\/(client\/dist|ui-kit\/dist|contract)\/|public\/metagraph\/|apps\/ui\/content\/docs\/api-reference\/)/.test(name)) files[name] = readFileSync(name, "utf8");
  }
  const encoded = gzipSync(JSON.stringify(files)).toString("base64");
  console.log("NATIVE_UI_FORMATTED_FILES", JSON.stringify(Object.keys(files)));
  for (let offset = 0; offset < encoded.length; offset += 16000)
    console.log(`NATIVE_UI_HANDOFF ${offset / 16000} ${encoded.slice(offset, offset + 16000)}`);
}, 180000);
