// Temporary remote-only formatter; removed after reviewed hash-bound import.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { format, resolveConfig } from "prettier";
import { test } from "vitest";

test("format reviewed native HTTP fixture on remote CI", async () => {
  if (!process.env.CI) return;
  for (const path of ["src/native-code-artifact.ts", "tests/native-runtime-v470.test.ts"]) {
    const data = Buffer.from(await format(await readFile(path, "utf8"), { ...(await resolveConfig(path)), filepath: path }));
    console.log("NATIVE_HTTP_FORMAT_FILE", path, data.length, createHash("sha256").update(data).digest("hex"));
    const encoded = gzipSync(data).toString("base64");
    for (let offset = 0; offset < encoded.length; offset += 16000) console.log(`NATIVE_HTTP_FORMAT ${path} ${offset / 16000} ${encoded.slice(offset, offset + 16000)}`);
  }
});
