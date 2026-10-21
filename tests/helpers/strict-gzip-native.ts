import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Miniflare } from "miniflare";
import { installHostNetworkGuard } from "./strict-gzip-host-guard.ts";

export const STRICT_GZIP_TESTED_SOURCE_SHA256 =
  "5b7e858b87ab29fef86dc374c48a5ee105bb7c4d3af3a5f1fa603f46a4fd6dec";

const sha256 = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** Focused native primitive fixture. No Wrangler build or application graph. */
export async function createStrictGzipNativeFixture() {
  for (const name of [
    "NODE_OPTIONS",
    "VSCODE_INSPECTOR_OPTIONS",
    "ESBUILD_BINARY_PATH",
    "MINIFLARE_WORKERD_PATH",
    "MINIFLARE_WORKERD_V8_FLAGS",
    "MINIFLARE_WORKERD_AUTOGATES",
    "MINIFLARE_WORKERD_CONFIG_DEBUG",
  ])
    assert.ok(
      !process.env[name],
      `Unexpected native fixture override: ${name}`,
    );
  const guard = installHostNetworkGuard();
  let runtime: Miniflare | undefined;
  const outbound: string[] = [];
  try {
    // Load installed packages only after host-side refusal is installed.
    const { build } = await import("esbuild");
    const { Miniflare, Response: MiniflareResponse } =
      await import("miniflare");
    const require = createRequire(import.meta.url);
    const requireMiniflare = createRequire(
      require.resolve("miniflare/package.json"),
    );
    const versions = {
      miniflare: require("miniflare/package.json").version,
      workerd: requireMiniflare("workerd/package.json").version,
      esbuild: require("esbuild/package.json").version,
    };
    assert.deepEqual(versions, {
      miniflare: "5.20260730.0-alpha",
      workerd: "1.20260730.1",
      esbuild: "0.28.2",
    });
    const sourcePath = fileURLToPath(
      new URL("../../src/strict-gzip-reader.ts", import.meta.url),
    );
    const workerPath = fileURLToPath(
      new URL("../fixtures/strict-gzip-worker.ts", import.meta.url),
    );
    const observerPath = fileURLToPath(
      new URL("../fixtures/strict-gzip-observer.ts", import.meta.url),
    );
    const source = await readFile(sourcePath, "utf8");
    assert.equal(
      sha256(source),
      STRICT_GZIP_TESTED_SOURCE_SHA256,
      "Re-review changed primitive",
    );
    const marker = "  let at = start;\n";
    assert.equal(source.split(marker).length - 1, 1);
    const instrumented =
      `import { observeInflater } from ${JSON.stringify(observerPath)};\n` +
      source.replace(
        marker,
        `  observeInflater(inflater, owned, start);\n${marker}`,
      );
    const bundle = await build({
      entryPoints: [workerPath],
      bundle: true,
      format: "esm",
      platform: "neutral",
      target: "es2022",
      conditions: ["workerd", "worker", "browser"],
      external: ["node:*"],
      write: false,
      metafile: true,
      logLevel: "silent",
      plugins: [
        {
          name: "observe-strict-gzip-primitive",
          setup(build) {
            build.onLoad({ filter: /strict-gzip-reader\.ts$/ }, (args) => {
              assert.equal(args.path, sourcePath);
              return {
                contents: instrumented,
                loader: "ts",
                resolveDir: path.dirname(sourcePath),
              };
            });
          },
        },
      ],
    });
    assert.equal(bundle.errors.length, 0);
    assert.equal(bundle.outputFiles.length, 1);
    const inputs = Object.keys(bundle.metafile.inputs)
      .map((input) => path.resolve(input))
      .sort();
    assert.deepEqual(inputs, [sourcePath, workerPath, observerPath].sort());
    const proof = {
      source_sha256: sha256(source),
      bundle_sha256: sha256(bundle.outputFiles[0]!.text),
      compatibility_date: "2026-06-06",
      compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
      versions,
      inputs,
    };
    runtime = new Miniflare({
      modules: true,
      script: bundle.outputFiles[0]!.text,
      compatibilityDate: proof.compatibility_date,
      compatibilityFlags: proof.compatibility_flags,
      host: "127.0.0.1",
      port: 0,
      cf: false,
      outboundService(request: { url: string }) {
        outbound.push(request.url);
        return new MiniflareResponse(null, { status: 502 });
      },
    });
    await runtime.ready;
    assert.deepEqual(guard.denied, []);
    return {
      runtime,
      proof,
      assertNoNetwork() {
        assert.deepEqual(guard.denied, []);
        assert.deepEqual(outbound, []);
      },
      async dispose() {
        try {
          await runtime?.dispose();
          assert.deepEqual(guard.denied, []);
          assert.deepEqual(outbound, []);
        } finally {
          guard.restore();
        }
      },
    };
  } catch (error) {
    try {
      await runtime?.dispose();
    } finally {
      guard.restore();
    }
    throw error;
  }
}
