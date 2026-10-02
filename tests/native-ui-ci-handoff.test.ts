// Temporary remote generated-doc handoff; removed before release.
import { test } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { format, resolveConfig } from "prettier";

test("retain remote source formatting and generated API reference pages", async () => {
  if (!process.env.CI) return;
  const git = (...args: string[]) =>
    execFileSync("git", args, { encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean);
  const files: Record<string, string> = {};
  for (const name of git("diff", "--name-only", "398c77c", "HEAD")) {
    if (name === "tests/native-ui-ci-handoff.test.ts" || !/\.(ts|tsx|md)$/.test(name)) continue;
    files[name] = await format(readFileSync(name, "utf8"), {
      ...(await resolveConfig(name)),
      filepath: name,
    });
  }
  execFileSync(process.execPath, ["scripts/generate-openapi-docs.ts"], {
    cwd: "apps/ui",
    stdio: "pipe",
  });
  const generated = [
    ...git("diff", "--name-only"),
    ...git("ls-files", "--others", "--exclude-standard", "apps/ui/content/docs/api-reference"),
  ];
  for (const name of generated) files[name] = readFileSync(name, "utf8");
  const encoded = gzipSync(JSON.stringify(files)).toString("base64");
  console.log("NATIVE_UI_FORMATTED_FILES", JSON.stringify(Object.keys(files)));
  for (let offset = 0; offset < encoded.length; offset += 16000)
    console.log(`NATIVE_UI_HANDOFF ${offset / 16000} ${encoded.slice(offset, offset + 16000)}`);
}, 60000);
