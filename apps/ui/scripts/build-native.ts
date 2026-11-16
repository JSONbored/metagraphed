import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const env = { ...process.env };
// The upstream preset forces Cloudflare when either sandbox marker is set.
delete env.LOVABLE_SANDBOX;
delete env.DEV_SERVER__PROJECT_PATH;
env.METAGRAPHED_UI_BUILD_TARGET = "node";
env.NITRO_PRESET = "node-server";
env.NODE_OPTIONS = "--max-old-space-size=4096";
env.UV_THREADPOOL_SIZE = "2";
const vite = resolve(dirname(require.resolve("vite/package.json")), "bin/vite.js");
const result = spawnSync(process.execPath, [vite, "build"], {
  cwd: root,
  env,
  stdio: "inherit",
  timeout: 600000,
});
if (result.error) throw result.error;
if (result.signal || result.status !== 0)
  throw new Error(`Native UI build failed (${result.signal ?? result.status})`);
const output = resolve(root, "dist/native");
if (!existsSync(resolve(output, "server/index.mjs")) || !existsSync(resolve(output, "public")))
  throw new Error("Native UI build did not produce its server and public assets");
const metadata = JSON.parse(readFileSync(resolve(output, "nitro.json"), "utf8"));
if (metadata.preset !== "node-server")
  throw new Error("Native UI build emitted an unexpected runtime preset");
