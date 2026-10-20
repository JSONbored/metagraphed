import { OWNER_PG_SOURCES, assertOwnerPgSource } from "./owner-pg-identity.ts";
// Uses the same genuine build-only command/envelope as the 490-test baseline.
// No test entrypoint, pg alias, module replacement, or secondary bundler.
import assert from "node:assert/strict";
import { execFile as callback } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { repoRoot, stripJsonComments } from "../../../scripts/lib.ts";
const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const execFile = promisify(callback);
export async function buildQueueOwner() {
  const outdir = await mkdtemp(
    path.join(tmpdir(), "data-api-quarantine-isolate-"),
  );
  const configText = await readFile(
    path.join(repoRoot, "wrangler.data.jsonc"),
    "utf8",
  );
  const config = JSON.parse(stripJsonComments(configText));
  assert.equal(config.main, "workers/data-api.ts");
  const live = config.queues.consumers.find(
    (row: { queue: string }) => row.queue === "sync-batches",
  );
  const dlq = config.queues.consumers.find(
    (row: { queue: string }) => row.queue === "sync-batches-dlq",
  );
  assert.equal(live.max_batch_size, 10);
  assert.equal(live.max_concurrency, 2);
  assert.equal(dlq.max_batch_size, 100);
  assert.equal(dlq.max_concurrency, 1);
  const modulesRoot = path.join(outdir, "modules"),
    outfile = path.join(outdir, "upload.multipart"),
    envFile = path.join(outdir, "empty.env");
  await writeFile(envFile, "");
  assert.equal(existsSync(path.join(homedir(), ".wrangler")), false);
  try {
    await execFile(
      process.execPath,
      [
        path.join(repoRoot, "node_modules/wrangler/bin/wrangler.js"),
        "deploy",
        "--config",
        "wrangler.data.jsonc",
        "--dry-run",
        "--outdir",
        modulesRoot,
        "--outfile",
        outfile,
        "--upload-source-maps",
        "--env-file",
        envFile,
      ],
      {
        cwd: repoRoot,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          CI: "true",
          NODE_ENV: "production",
          XDG_CONFIG_HOME: path.join(outdir, "config"),
          XDG_CACHE_HOME: path.join(outdir, "cache"),
          CLOUDFLARE_AUTH_USE_KEYRING: "false",
          WRANGLER_SEND_METRICS: "false",
        } as NodeJS.ProcessEnv,
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      },
    );
  } catch {
    await rm(outdir, { recursive: true, force: true });
    throw new Error("Queue owner dry run failed");
  }
  try {
    const upload = await readFile(outfile);
    assert.ok(upload.byteLength <= 64 * 1024 * 1024);
    const boundaryEnd = upload.indexOf("\r\n");
    assert.ok(boundaryEnd > 2 && boundaryEnd < 200);
    const first = upload.subarray(0, boundaryEnd).toString();
    assert.match(first, /^--[-A-Za-z0-9]+$/);
    const form = await new Response(new Uint8Array(upload).buffer, {
      headers: {
        "Content-Type": `multipart/form-data; boundary=${first.slice(2)}`,
      },
    }).formData();
    const metadataText = form.get("metadata");
    assert.equal(typeof metadataText, "string");
    const metadata = JSON.parse(metadataText as string);
    assert.equal(metadata.main_module, "data-api.js");
    assert.equal(metadata.compatibility_date, config.compatibility_date);
    assert.deepEqual(metadata.compatibility_flags, config.compatibility_flags);
    const types = {
      "application/javascript+module": "ESModule",
      "application/javascript": "CommonJS",
      "application/wasm": "CompiledWasm",
      "application/octet-stream": "Data",
      "text/plain": "Text",
    } as const;
    const modules: {
        type: (typeof types)[keyof typeof types];
        path: string;
      }[] = [],
      proof: { sha256: string; bytes: number }[] = [];
    const names = new Set<string>(),
      sourceMaps: { sources: string[]; sourcesContent: (string | null)[] }[] =
        [];
    for (const [name, value] of form) {
      if (name === "metadata") continue;
      assert.notEqual(typeof value, "string");
      const file = value as File;
      if (file.type === "application/source-map") {
        const map = JSON.parse(await file.text());
        assert.ok(
          Array.isArray(map.sources) &&
            Array.isArray(map.sourcesContent) &&
            map.sources.length === map.sourcesContent.length,
        );
        sourceMaps.push(map);
        continue;
      }
      assert.ok(Object.hasOwn(types, file.type) && !names.has(name));
      names.add(name);
      const modulePath = path.resolve(modulesRoot, name);
      assert.ok(modulePath.startsWith(modulesRoot + path.sep));
      const bytes = await readFile(modulePath);
      assert.deepEqual(
        new Uint8Array(await file.arrayBuffer()),
        new Uint8Array(bytes),
      );
      modules.push({
        type: types[file.type as keyof typeof types],
        path: modulePath,
      });
      proof.push({ sha256: digest(bytes), bytes: bytes.length });
    }
    assert.ok(names.has(metadata.main_module));
    modules.sort((a, b) =>
      path.relative(modulesRoot, a.path) === metadata.main_module
        ? -1
        : path.relative(modulesRoot, b.path) === metadata.main_module
          ? 1
          : a.path.localeCompare(b.path),
    );
    const lock = JSON.parse(
      await readFile(path.join(repoRoot, "package-lock.json"), "utf8"),
    );
    for (const [name, version] of [
      ["pg", "8.22.0"],
      ["pg-cloudflare", "1.4.0"],
      ["pg-protocol", "1.15.0"],
      ["pg-connection-string", "2.14.0"],
    ]) {
      const installed = JSON.parse(
        await readFile(
          path.join(repoRoot, "node_modules", name!, "package.json"),
          "utf8",
        ),
      );
      assert.equal(installed.version, version);
      assert.equal(lock.packages[`node_modules/${name}`].version, version);
    }
    const pgSources = [];
    for (const relative of Object.keys(OWNER_PG_SOURCES)) {
      const installed = await readFile(
        path.join(repoRoot, "node_modules", relative),
        "utf8",
      );
      assertOwnerPgSource(relative, installed);
      const matches = sourceMaps
        .flatMap((map) =>
          map.sources.map((source, index) => ({
            source,
            content: map.sourcesContent[index],
          })),
        )
        .filter((row) =>
          row.source.replaceAll("\\", "/").endsWith(`node_modules/${relative}`),
        );
      assert.ok(
        matches.length > 0,
        "Actual pg source absent from genuine bundle map",
      );
      for (const match of matches) assert.equal(match.content, installed);
      pgSources.push({
        sha256: digest(installed),
        bytes: Buffer.byteLength(installed),
      });
    }
    return {
      upload,
      modules,
      modulesRoot,
      compatibilityDate: metadata.compatibility_date as string,
      compatibilityFlags: metadata.compatibility_flags as string[],
      proof,
      pgSources,
      configSha256: digest(configText),
      cleanup: () => rm(outdir, { recursive: true, force: true }),
    };
  } catch {
    await rm(outdir, { recursive: true, force: true });
    throw new Error("Queue owner bundle identity failed");
  }
}
