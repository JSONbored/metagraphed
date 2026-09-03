// Preserve dynamic imports as native Worker modules. Wrangler's single bundle
// otherwise makes every request parse the MCP, GraphQL and image dependencies
// before entering the handler, including a cached directory read (#11760).
import { build } from "esbuild";
import { rm } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot } from "./lib.ts";

export async function buildApiWorker(
  outdir = path.join(repoRoot, "dist/api-modules"),
) {
  await rm(outdir, { recursive: true, force: true });
  return build({
    absWorkingDir: repoRoot,
    entryPoints: ["workers/api.entry.ts"],
    outdir,
    // Keep exactly one top-level JS entry for the sourcemap deploy wrapper.
    // It injects/uploads this directory recursively before shipping it intact.
    chunkNames: "chunks/[name]-[hash]",
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    target: "es2024",
    minify: true,
    sourcemap: true,
    metafile: true,
    conditions: ["workerd", "worker", "browser"],
    loader: { ".wasm": "copy" },
    external: ["cloudflare:*"],
    plugins: [
      {
        name: "native-node-requires",
        setup(builder) {
          // CommonJS dependencies such as pg require Node builtins. A bare
          // external require survives esbuild and throws inside an ESM Worker.
          // Import workerd's nodejs_compat implementation and expose that same
          // value to the CJS module; do not substitute browser polyfills.
          builder.onResolve({ filter: /.*/ }, (args) => {
            if (!isBuiltin(args.path)) return;
            if (args.kind === "require-call") {
              return {
                path: args.path.replace(/^node:/, ""),
                namespace: "native-node-require",
              };
            }
            return {
              path: args.path.startsWith("node:")
                ? args.path
                : `node:${args.path}`,
              external: true,
            };
          });
          builder.onLoad(
            { filter: /.*/, namespace: "native-node-require" },
            (args) => ({
              contents: `import native from 'node:${args.path}'; module.exports = native;`,
              loader: "js",
            }),
          );
        },
      },
    ],
    define: {
      "process.env.NODE_ENV": '"production"',
      "global.process.env.NODE_ENV": '"production"',
      "globalThis.process.env.NODE_ENV": '"production"',
    },
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildApiWorker();
}
