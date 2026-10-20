import { OWNER_PG_SOURCES, assertOwnerPgSource } from "./owner-pg-identity.ts";
// Private build evidence is never uploaded. Only validated hashes/counts escape.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { isBuiltin } from "node:module";

import type { Owner } from "./owner-resource-policy.ts";
function sourceFile(root: string, relative: string): string {
  relativeName(relative);
  const file = path.join(root, relative);
  regular(file);
  const canonical = realpathSync(file);
  const allowed = relative.startsWith("node_modules/")
    ? realpathSync(path.join(root, "node_modules"))
    : realpathSync(root);
  assert.ok(canonical.startsWith(allowed + path.sep));
  return file;
}
export function boundedBuildFile(file: string, maximum: number): Buffer {
  assert.ok(
    Number.isSafeInteger(maximum) &&
      maximum >= 0 &&
      maximum <= 256 * 1024 * 1024,
  );
  const fd = openSync(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(fd);
    assert.ok(stat.isFile() && stat.size <= maximum);
    const bytes = Buffer.alloc(stat.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = readSync(fd, bytes, used, bytes.length - used, null);
      if (!count) break;
      used += count;
    }
    assert.equal(used, stat.size);
    assert.equal(fstatSync(fd).size, stat.size);
    return bytes.subarray(0, used);
  } finally {
    closeSync(fd);
  }
}
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export const OWNER_BUILD_LIMITS = {
  files: 257,
  moduleBytes: 32 * 1024 * 1024,
  totalBytes: 128 * 1024 * 1024,
  associationBytes: 64 * 1024 * 1024,
  manifestBytes: 512 * 1024,
} as const;
export interface RegisteredOwnerModule {
  name: string;
  type: "ESModule" | "CommonJS" | "CompiledWasm" | "Data" | "Text";
  bytes: Uint8Array;
}
interface SourceIdentity {
  path: string;
  sha256: string;
}
export interface OwnerBuildManifest {
  version: 1;
  owner: Owner;
  entry: string;
  association: {
    kind: "api-builder" | "wrangler-upload";
    file: "association.bin";
    bytes: number;
    sha256: string;
  };
  modules: {
    name: string;
    type: RegisteredOwnerModule["type"];
    file: string;
    bytes: number;
    sha256: string;
  }[];
  sources: SourceIdentity[];
}
export interface ExpectedOwnerIdentity {
  runtimeSha256: string;
  modules: { sha256: string; bytes: number }[];
}
function regular(file: string) {
  const info = lstatSync(file);
  assert.ok(info.isFile() && !info.isSymbolicLink());
}
function relativeName(name: string) {
  assert.ok(
    name.length > 0 &&
      name.length <= 512 &&
      !path.isAbsolute(name) &&
      !name.includes("\\") &&
      !name.split("/").some((part) => part === ".." || !part || part === "."),
  );
}
const requiredSources = {
  raw: [
    "workers/api.entry.ts",
    "workers/api.ts",
    "scripts/build-api-worker.ts",
    "src/raw-chain-capture.ts",
    "src/raw-capture-d1.ts",
    "wrangler.jsonc",
  ],
  queue: [
    "workers/data-api.ts",
    "wrangler.data.jsonc",
    "src/pg-sql.ts",
    "src/sync-batch-compress.ts",
    "src/strict-gzip-reader.ts",
    ...Object.keys(OWNER_PG_SOURCES).map(
      (relative) => `node_modules/${relative}`,
    ),
  ],
} as const;
export function preserveOwnerBuild(
  owner: Owner,
  entry: string,
  modules: RegisteredOwnerModule[],
  sourcePaths: string[],
  association: { kind: "api-builder" | "wrangler-upload"; bytes: Uint8Array },
) {
  const result = process.env.DECODER_QUALIFICATION_RESULT,
    root = process.env.DECODER_QUALIFICATION_ROOT;
  assert.ok(result && root && path.isAbsolute(result) && path.isAbsolute(root));
  const directory = path.join(path.dirname(result), "owner-builds", owner);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assert.equal(readdirSync(directory).length, 0);
  assert.ok(
    modules.length > 0 && modules.length <= OWNER_BUILD_LIMITS.files - 2,
  );
  let total = 0;
  const names = new Set<string>();
  const stored = modules.map((module, index) => {
    relativeName(module.name);
    assert.ok(!names.has(module.name));
    names.add(module.name);
    assert.ok(
      ["ESModule", "CommonJS", "CompiledWasm", "Data", "Text"].includes(
        module.type,
      ),
    );
    assert.ok(
      module.bytes.byteLength > 0 &&
        module.bytes.byteLength <= OWNER_BUILD_LIMITS.moduleBytes,
    );
    total += module.bytes.byteLength;
    assert.ok(total <= OWNER_BUILD_LIMITS.totalBytes);
    const file = `module-${String(index).padStart(3, "0")}.bin`;
    writeFileSync(path.join(directory, file), module.bytes, {
      flag: "wx",
      mode: 0o600,
    });
    return {
      name: module.name,
      type: module.type,
      file,
      bytes: module.bytes.byteLength,
      sha256: hash(module.bytes),
    };
  });
  assert.equal(entry, owner === "raw" ? "api.entry.js" : "data-api.js");
  assert.ok(names.has(entry));
  assert.equal(
    modules.find((module) => module.name === entry)!.type,
    "ESModule",
  );
  const sources = [...new Set([...sourcePaths, ...requiredSources[owner]])]
    .sort()
    .map((relative) => {
      const file = sourceFile(root, relative);
      const bytes = boundedBuildFile(file, 32 * 1024 * 1024);
      return { path: relative, sha256: hash(bytes) };
    });
  assert.equal(
    association.kind,
    owner === "raw" ? "api-builder" : "wrangler-upload",
  );
  assert.ok(
    association.bytes.byteLength > 0 &&
      association.bytes.byteLength <= OWNER_BUILD_LIMITS.associationBytes,
  );
  assert.ok(
    total + association.bytes.byteLength <= OWNER_BUILD_LIMITS.totalBytes,
  );
  writeFileSync(path.join(directory, "association.bin"), association.bytes, {
    flag: "wx",
    mode: 0o600,
  });
  const manifest: OwnerBuildManifest = {
    version: 1,
    owner,
    entry,
    modules: stored,
    sources,
    association: {
      kind: association.kind,
      file: "association.bin",
      bytes: association.bytes.byteLength,
      sha256: hash(association.bytes),
    },
  };
  const serialized = JSON.stringify(manifest) + "\n";
  assert.ok(Buffer.byteLength(serialized) <= OWNER_BUILD_LIMITS.manifestBytes);
  writeFileSync(path.join(directory, "manifest.json"), serialized, {
    flag: "wx",
    mode: 0o600,
  });
  return manifest.modules.map(({ sha256, bytes }) => ({ sha256, bytes }));
}
export async function validateOwnerBuild(
  directory: string,
  owner: Owner,
  root: string,
  expectedRuntimeSha256: string,
): Promise<ExpectedOwnerIdentity> {
  assert.match(expectedRuntimeSha256, /^[a-f0-9]{64}$/);
  const stat = lstatSync(directory);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
  const entries = readdirSync(directory, { withFileTypes: true });
  assert.ok(entries.length >= 2 && entries.length <= OWNER_BUILD_LIMITS.files);
  assert.ok(
    entries.every((entry) => entry.isFile() && !entry.isSymbolicLink()),
  );
  const manifest = JSON.parse(
    boundedBuildFile(
      path.join(directory, "manifest.json"),
      OWNER_BUILD_LIMITS.manifestBytes,
    ).toString(),
  ) as OwnerBuildManifest;
  assert.equal(manifest.version, 1);
  assert.equal(manifest.owner, owner);
  assert.ok(
    Array.isArray(manifest.modules) &&
      manifest.modules.length > 0 &&
      manifest.modules.length <= OWNER_BUILD_LIMITS.files - 2,
  );
  assert.deepEqual(
    entries.map((e) => e.name).sort(),
    [
      "manifest.json",
      "association.bin",
      ...manifest.modules.map((row) => row.file),
    ].sort(),
  );
  let total = 0;
  const names = new Set<string>();
  const modules = manifest.modules.map((module, index) => {
    relativeName(module.name);
    assert.ok(!names.has(module.name));
    names.add(module.name);
    assert.ok(
      ["ESModule", "CommonJS", "CompiledWasm", "Data", "Text"].includes(
        module.type,
      ),
    );
    assert.equal(module.file, `module-${String(index).padStart(3, "0")}.bin`);
    const bytes = boundedBuildFile(
      path.join(directory, module.file),
      OWNER_BUILD_LIMITS.moduleBytes,
    );
    total += bytes.byteLength;
    assert.ok(total <= OWNER_BUILD_LIMITS.totalBytes);
    assert.equal(bytes.byteLength, module.bytes);
    assert.ok(module.bytes > 0);
    assert.equal(hash(bytes), module.sha256);
    return { sha256: module.sha256, bytes: module.bytes };
  });
  assert.equal(
    manifest.entry,
    owner === "raw" ? "api.entry.js" : "data-api.js",
  );
  assert.ok(names.has(manifest.entry));
  assert.equal(
    manifest.modules.find((module) => module.name === manifest.entry)!.type,
    "ESModule",
  );
  assert.ok(
    Array.isArray(manifest.sources) &&
      manifest.sources.length > 0 &&
      manifest.sources.length <= 4096,
  );
  const seen = new Set<string>();
  for (const source of manifest.sources) {
    relativeName(source.path);
    assert.ok(!seen.has(source.path));
    seen.add(source.path);
    assert.equal(
      hash(boundedBuildFile(sourceFile(root, source.path), 32 * 1024 * 1024)),
      source.sha256,
    );
  }
  for (const required of requiredSources[owner]) assert.ok(seen.has(required));
  if (owner === "queue")
    for (const relative of Object.keys(OWNER_PG_SOURCES))
      assertOwnerPgSource(
        relative,
        boundedBuildFile(
          sourceFile(root, `node_modules/${relative}`),
          32 * 1024 * 1024,
        ),
      );
  assert.equal(
    manifest.association.kind,
    owner === "raw" ? "api-builder" : "wrangler-upload",
  );
  assert.equal(manifest.association.file, "association.bin");
  const association = boundedBuildFile(
    path.join(directory, "association.bin"),
    OWNER_BUILD_LIMITS.associationBytes,
  );
  assert.equal(association.byteLength, manifest.association.bytes);
  assert.equal(hash(association), manifest.association.sha256);
  assert.ok(total + association.byteLength <= OWNER_BUILD_LIMITS.totalBytes);
  await validateBuildAssociation(owner, association, manifest, root, directory);
  return { runtimeSha256: expectedRuntimeSha256, modules };
}

export function runnerRuntimeIdentity(run: string, root: string): string {
  const config = JSON.parse(
    boundedBuildFile(path.join(run, "guard-config.json"), 32 * 1024).toString(),
  );
  assert.equal(config.root, realpathSync(root));
  assert.ok(Array.isArray(config.allowedNativeExecutables));
  const expected = realpathSync(
    path.join(
      root,
      "node_modules/miniflare/node_modules/@cloudflare/workerd-linux-64/bin/workerd",
    ),
  );
  const matches = config.allowedNativeExecutables.filter(
    (row: Record<string, unknown>) =>
      row.packagePath ===
      "node_modules/miniflare/node_modules/@cloudflare/workerd-linux-64",
  );
  assert.equal(matches.length, 1);
  assert.equal(matches[0].path, expected);
  assert.equal(matches[0].version, "1.20260730.1");
  assert.equal(
    matches[0].sha256,
    hash(boundedBuildFile(expected, 256 * 1024 * 1024)),
  );
  return matches[0].sha256;
}

async function validateBuildAssociation(
  owner: Owner,
  bytes: Buffer,
  manifest: OwnerBuildManifest,
  root: string,
  directory: string,
) {
  const moduleBytes = (name: string) => {
    const row = manifest.modules.find((module) => module.name === name);
    assert.ok(row);
    return boundedBuildFile(
      path.join(directory, row.file),
      OWNER_BUILD_LIMITS.moduleBytes,
    );
  };
  const matchSources = (
    map: Record<string, unknown>,
    sourceNames: readonly string[],
  ) => {
    assert.equal(map.version, 3);
    assert.ok(Array.isArray(map.sources) && Array.isArray(map.sourcesContent));
    assert.equal(map.sources.length, map.sourcesContent.length);
    assert.ok(map.sources.length <= 8192);
    for (const relative of sourceNames) {
      const matches: number[] = (map.sources as unknown[]).flatMap(
        (source, index) =>
          typeof source === "string" &&
          (source === relative ||
            source.replaceAll("\\", "/").endsWith("/" + relative))
            ? [index]
            : [],
      );
      if (!matches.length) continue;
      for (const index of matches)
        assert.equal(
          (map.sourcesContent as unknown[])[index],
          boundedBuildFile(
            sourceFile(root, relative),
            32 * 1024 * 1024,
          ).toString(),
        );
    }
  };
  if (owner === "queue") {
    const end = bytes.indexOf("\r\n");
    assert.ok(end > 2 && end < 200);
    const line = bytes.subarray(0, end).toString();
    assert.match(line, /^--[-A-Za-z0-9]+$/);
    const form = await new Response(new Uint8Array(bytes).buffer, {
      headers: {
        "Content-Type": `multipart/form-data; boundary=${line.slice(2)}`,
      },
    }).formData();
    const metadata = form.get("metadata");
    assert.equal(typeof metadata, "string");
    const info = JSON.parse(metadata as string);
    assert.equal(info.main_module, "data-api.js");
    assert.equal(info.compatibility_date, "2026-06-06");
    assert.deepEqual(info.compatibility_flags, ["nodejs_compat"]);
    const types = {
      "application/javascript+module": "ESModule",
      "application/javascript": "CommonJS",
      "application/wasm": "CompiledWasm",
      "application/octet-stream": "Data",
      "text/plain": "Text",
    };
    const seen = new Set<string>(),
      maps: Record<string, unknown>[] = [];
    for (const [name, value] of form) {
      if (name === "metadata") continue;
      assert.notEqual(typeof value, "string");
      const file = value as File;
      if (file.type === "application/source-map") {
        assert.ok(file.size <= OWNER_BUILD_LIMITS.associationBytes);
        maps.push(JSON.parse(await file.text()));
        continue;
      }
      assert.ok(!seen.has(name));
      seen.add(name);
      const expected = manifest.modules.find((module) => module.name === name);
      assert.ok(expected);
      assert.equal(expected.type, types[file.type as keyof typeof types]);
      assert.deepEqual(
        Buffer.from(await file.arrayBuffer()),
        moduleBytes(name),
      );
    }
    assert.deepEqual(
      [...seen].sort(),
      manifest.modules.map((module) => module.name).sort(),
    );
    assert.ok(maps.length > 0 && maps.length <= 256);
    const actualSources = manifest.sources
      .map((source) => source.path)
      .filter((source) => source !== "wrangler.data.jsonc");
    for (const map of maps) matchSources(map, actualSources);
    for (const required of requiredSources.queue.filter(
      (source) => source !== "wrangler.data.jsonc",
    ))
      assert.ok(
        maps.some((map) =>
          (map.sources as string[]).some(
            (source) =>
              source === required ||
              source.replaceAll("\\", "/").endsWith("/" + required),
          ),
        ),
        "Required genuine bundle source association missing",
      );
    return;
  }
  const association = JSON.parse(bytes.toString());
  assert.equal(association.kind, "esbuild-api");
  assert.equal(association.sourceRoot, realpathSync(root));
  assert.equal(
    association.dependencyRoot,
    realpathSync(path.join(root, "node_modules")),
  );
  assert.ok(
    typeof association.outputRoot === "string" &&
      path.isAbsolute(association.outputRoot),
  );
  assert.match(
    association.outputRoot,
    /\/raw-owner-qualification-[A-Za-z0-9]+\/modules$/,
  );
  assert.ok(
    Array.isArray(association.outputs) && association.outputs.length <= 1024,
  );
  assert.ok(
    Array.isArray(association.sourceMaps) &&
      association.sourceMaps.length <= 512,
  );
  const meta = association.metafile;
  assert.ok(
    meta && typeof meta.inputs === "object" && typeof meta.outputs === "object",
  );
  const inputs = Object.keys(meta.inputs);
  assert.ok(inputs.length > 0 && inputs.length <= 8192);
  const knownSources = new Set(manifest.sources.map((source) => source.path));
  for (const name of inputs) {
    if (name.startsWith("native-node-require:")) {
      assert.match(name, /^native-node-require:[A-Za-z0-9_/-]+$/);
      assert.ok(isBuiltin(name.slice("native-node-require:".length)));
      continue;
    }
    const relative = path.relative(root, path.resolve(root, name));
    relativeName(relative);
    assert.ok(knownSources.has(relative));
    assert.equal(
      meta.inputs[name].bytes,
      boundedBuildFile(sourceFile(root, relative), 32 * 1024 * 1024).byteLength,
    );
  }
  const outputNames = new Map<string, string>();
  for (const name of Object.keys(meta.outputs)) {
    const absolute = path.resolve(root, name);
    assert.ok(absolute.startsWith(association.outputRoot + path.sep));
    const relative = path.relative(association.outputRoot, absolute);
    relativeName(relative);
    assert.ok(!outputNames.has(relative));
    outputNames.set(relative, name);
  }
  assert.equal(outputNames.size, association.outputs.length);
  const maps = new Map<string, Record<string, unknown>>();
  for (const map of association.sourceMaps) {
    relativeName(map.name);
    assert.ok(map.name.endsWith(".js.map") && !maps.has(map.name));
    assert.equal(typeof map.base64, "string");
    const decoded = Buffer.from(map.base64, "base64");
    assert.equal(decoded.toString("base64"), map.base64);
    assert.ok(decoded.length <= OWNER_BUILD_LIMITS.associationBytes);
    const parsed = JSON.parse(decoded.toString());
    matchSources(parsed, [...knownSources]);
    maps.set(map.name, parsed);
    assert.equal(
      meta.outputs[outputNames.get(map.name)!]?.bytes,
      decoded.length,
    );
  }
  const seen = new Set<string>(),
    edges: { from: string; to: string; dynamic: boolean }[] = [];
  for (const output of association.outputs) {
    relativeName(output.name);
    assert.ok(!seen.has(output.name));
    seen.add(output.name);
    assert.equal(output.metafilePath, outputNames.get(output.name));
    const info = meta.outputs[output.metafilePath];
    assert.ok(info);
    if (output.type === "SourceMap") {
      assert.ok(maps.has(output.name));
      assert.equal(output.sourceMapName, null);
      const sourceMap = association.sourceMaps.find(
        (row: { name: string }) => row.name === output.name,
      );
      assert.equal(
        output.sha256,
        hash(Buffer.from(sourceMap.base64, "base64")),
      );
      continue;
    }
    assert.ok(output.type === "ESModule" || output.type === "CompiledWasm");
    const registered = manifest.modules.find(
      (module) => module.name === output.name,
    );
    assert.ok(registered);
    assert.equal(registered.type, output.type);
    assert.equal(info.bytes, registered.bytes);
    assert.equal(output.sha256, hash(moduleBytes(output.name)));
    if (output.type === "ESModule") {
      assert.equal(output.sourceMapName, output.name + ".map");
      assert.ok(maps.has(output.sourceMapName));
    } else {
      assert.equal(output.sourceMapName, null);
      assert.deepEqual(
        [...moduleBytes(output.name).subarray(0, 8)],
        [0, 97, 115, 109, 1, 0, 0, 0],
      );
    }
    assert.ok(Array.isArray(info.imports));
    for (const dependency of info.imports) {
      if (dependency.external) {
        assert.match(dependency.path, /^(?:node:|cloudflare:)/);
        continue;
      }
      const candidates = [
        ...new Set([
          path.resolve(root, dependency.path),
          path.resolve(
            association.outputRoot,
            path.dirname(output.name),
            dependency.path,
          ),
        ]),
      ]
        .map((candidate) => path.relative(association.outputRoot, candidate))
        .filter((candidate) => outputNames.has(candidate));
      assert.equal(candidates.length, 1);
      edges.push({
        from: output.name,
        to: candidates[0]!,
        dynamic: dependency.kind === "dynamic-import",
      });
    }
  }
  assert.deepEqual([...seen].sort(), [...outputNames.keys()].sort());
  assert.deepEqual(
    association.outputs
      .filter((output: { type: string }) => output.type !== "SourceMap")
      .map((output: { name: string }) => output.name)
      .sort(),
    manifest.modules.map((module) => module.name).sort(),
  );
  const entryInfo = meta.outputs[outputNames.get("api.entry.js")!];
  assert.equal(entryInfo.entryPoint, "workers/api.entry.ts");
  assert.deepEqual([...entryInfo.exports].sort(), [
    "AlerterHub",
    "ChainFirehoseHub",
    "McpSessionHub",
    "NeonWriteBufferHub",
    "SubnetStatusHub",
    "default",
  ]);
  const closure = (dynamic: boolean) => {
    const reached = new Set(["api.entry.js"]);
    for (let previous = -1; previous !== reached.size;) {
      previous = reached.size;
      for (const edge of edges)
        if (reached.has(edge.from) && (dynamic || !edge.dynamic))
          reached.add(edge.to);
    }
    return reached;
  };
  assert.deepEqual(
    [...closure(true)].sort(),
    manifest.modules.map((module) => module.name).sort(),
  );
  const eager = closure(false);
  for (const required of [
    "workers/api.entry.ts",
    "workers/api.ts",
    "src/raw-capture-sync.ts",
    "src/raw-chain-capture.ts",
    "src/raw-capture-d1.ts",
  ]) {
    const names = inputs.filter(
      (name) => path.resolve(root, name) === path.join(root, required),
    );
    assert.equal(names.length, 1);
    const contributions = Object.entries(meta.outputs).filter(
      ([, output]) =>
        ((output as { inputs: Record<string, { bytesInOutput: number }> })
          .inputs[names[0]!]?.bytesInOutput ?? 0) > 0,
    );
    assert.ok(contributions.length > 0);
    for (const [output] of contributions) {
      const relative = path.relative(
        association.outputRoot,
        path.resolve(root, output),
      );
      const map = maps.get(relative + ".map");
      assert.ok(map);
      const matches = (map.sources as string[]).flatMap((source, index) =>
        source === required ||
        source.replaceAll("\\", "/").endsWith("/" + required)
          ? [index]
          : [],
      );
      assert.ok(matches.length > 0);
      for (const index of matches)
        assert.equal(
          (map.sourcesContent as unknown[])[index],
          boundedBuildFile(
            sourceFile(root, required),
            32 * 1024 * 1024,
          ).toString(),
        );
    }
    if (required === "workers/api.ts")
      assert.ok(
        contributions.every(
          ([output]) =>
            !eager.has(
              path.relative(association.outputRoot, path.resolve(root, output)),
            ),
        ),
      );
  }
}
