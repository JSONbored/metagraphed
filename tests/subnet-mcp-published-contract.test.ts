// Source-pinned catalog qualification on existing remote CI only.
// Package hooks and provider APIs are never invoked; published code runs in a
// separate permission-restricted Node process with an empty environment.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { posix } from "node:path";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { test } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { runSubnetMcp } from "../src/subnet-mcp-client.ts";
import { MAX_RESPONSE_BYTES } from "../src/call-subnet-surface.ts";

const require = createRequire(import.meta.url);
const packageUrl =
  "https://registry.npmjs.org/@loopover/contract/-/contract-3.21.2.tgz";
const packageIntegrity =
  "zng53d5zs648MeTbIzED6p/RF7mnxRaT4J4lwnikH2EvFwiKvtXB+BpMfgVAfAMrDZkED4QEcyME49+dgwRgSA==";
const sdkSources = [
  {
    name: "zod-json-schema-compat.js",
    sha: "c639ae841e53d32479cd8e4df2f373400cfe9b44bba072cafdf34a7235990dfa",
  },
  {
    name: "zod-compat.js",
    sha: "004a5c0ce02b1100d8387053025560ac897288a6aafed9a9af8cd7cd42101fd7",
  },
] as const;
const endpoint = "https://published-contract.fixture.invalid/mcp";
const manifest = JSON.parse(
  readFileSync(new URL("../registry/subnets/gittensor.json", import.meta.url), "utf8"),
);
const admission = manifest.surfaces.find(
  (surface: { id: string }) => surface.id === "gittensory-mcp",
).mcp as { read_tools: string[]; write_tools: string[] };

function download(url: string, maximum: number): Buffer {
  assert.equal(process.env.CI, "true", "published catalog belongs on remote CI");
  return execFileSync(
    "curl",
    [
      "--fail",
      "--silent",
      "--show-error",
      "--max-time",
      "30",
      "--retry",
      "2",
      "--retry-delay",
      "1",
      "--max-filesize",
      String(maximum),
      url,
    ],
    { maxBuffer: maximum, timeout: 100_000 },
  );
}

function publishedFiles(blob: Buffer): Map<string, string> {
  assert.equal(createHash("sha512").update(blob).digest("base64"), packageIntegrity);
  const tar = gunzipSync(blob, { maxOutputLength: 4 * 1024 * 1024 });
  const files = new Map<string, string>();
  let fileCount = 0;
  let fileBytes = 0;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
    assert.match(sizeText, /^[0-7]+$/);
    const size = Number.parseInt(sizeText, 8);
    assert.ok(size <= 262_144);
    assert.ok(offset + 512 + size <= tar.length);
    assert.ok(header[156] === 0 || header[156] === 48, "only regular package files");
    assert.match(name, /^package\/(?:dist\/[a-zA-Z0-9./-]+|package\.json|CHANGELOG\.md)$/);
    assert.ok(!name.includes("..") && !files.has(name));
    const bytes = tar.subarray(offset + 512, offset + 512 + size);
    if (name.endsWith(".js")) {
      files.set(name, new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    }
    fileCount++;
    fileBytes += size;
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.equal(fileCount, 115);
  assert.equal(fileBytes, 1_895_292);
  return files;
}

let prepared: Promise<Tool[]> | undefined;
function publishedCatalog(): Promise<Tool[]> {
  return (prepared ??= (async () => {
    const files = publishedFiles(download(packageUrl, 1024 * 1024));
    for (const source of sdkSources) {
      const bytes = download(
        `https://cdn.jsdelivr.net/npm/@modelcontextprotocol/sdk@1.29.0/dist/esm/server/${source.name}`,
        65_536,
      );
      assert.equal(createHash("sha256").update(bytes).digest("hex"), source.sha);
      files.set(
        `provider-sdk/server/${source.name}`,
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    }
    // Mirrors the provider's contract-backed registration and SDK1.29 tools/list
    // projection. All compiled contracts form a conservative catalog superset;
    // this does not assert which conditional tools a deployment enables.
    const entry = `
import { TOOL_CONTRACTS, getToolDefinition } from "provider-contract";
import { normalizeObjectSchema } from "provider-object-schema";
import { toJsonSchemaCompat } from "provider-json-schema";
export const catalog = TOOL_CONTRACTS.map((contract) => {
  if (!contract.input._zod || !contract.output._zod) throw Error("expected Zod4");
  const advertised = getToolDefinition(contract.name);
  return {
    name: contract.name,
    title: advertised.title,
    description: advertised.description,
    inputSchema: toJsonSchemaCompat(normalizeObjectSchema(contract.input), {
      strictUnions: true, pipeStrategy: "input"
    }),
    annotations: advertised.annotations,
    execution: { taskSupport: "forbidden" },
    _meta: { category: advertised.category },
    outputSchema: toJsonSchemaCompat(normalizeObjectSchema(contract.output), {
      strictUnions: true, pipeStrategy: "output"
    })
  };
});`;
    const aliases: Record<string, string> = {
      "provider-contract": "package/dist/tools/index.js",
      "provider-object-schema": "provider-sdk/server/zod-compat.js",
      "provider-json-schema": "provider-sdk/server/zod-json-schema-compat.js",
    };
    const bundled = await build({
      stdin: { contents: entry, resolveDir: process.cwd(), loader: "js" },
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      globalName: "publishedContract",
      define: { "process.env.NODE_ENV": '"production"' },
      plugins: [{
        name: "pinned-published-files",
        setup(plugin) {
          plugin.onResolve({ filter: /^provider-/ }, (args) => ({
            path: aliases[args.path],
            namespace: "published",
          }));
          plugin.onResolve({ filter: /.*/, namespace: "published" }, (args) => {
            if (args.path === "zod-to-json-schema" || /^zod(?:\/|$)/.test(args.path))
              return { path: require.resolve(args.path), namespace: "file" };
            assert.ok(args.path.startsWith("."), "no upstream external capabilities");
            const path = posix.normalize(posix.join(posix.dirname(args.importer), args.path));
            assert.ok(files.has(path), "only checksum-pinned module imports");
            return { path, namespace: "published" };
          });
          plugin.onLoad({ filter: /.*/, namespace: "published" }, (args) => ({
            contents: files.get(args.path)!,
            loader: "js",
          }));
        },
      }],
    });
    assert.equal(bundled.outputFiles.length, 1);
    const code = bundled.outputFiles[0].text + "\nJSON.stringify(publishedContract.catalog)";
    assert.ok(Buffer.byteLength(code) < 4 * 1024 * 1024);
    const runner = `
import { runInNewContext } from "node:vm";
let source = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  source += chunk.toString("utf8");
  if (Buffer.byteLength(source) > 4 * 1024 * 1024) throw Error("source budget");
}
const result = runInNewContext(source, Object.create(null), {
  timeout: 20000, contextCodeGeneration: { strings: false, wasm: false }
});
if (typeof result !== "string" || Buffer.byteLength(result) > 4 * 1024 * 1024)
  throw Error("catalog budget");
process.stdout.write(result);`;
    const output = execFileSync(
      process.execPath,
      ["--permission", "--disable-proto=throw", "--input-type=module", "-e", runner],
      { input: code, env: {}, maxBuffer: 4 * 1024 * 1024, timeout: 30_000 },
    );
    const tools = JSON.parse(output.toString("utf8")) as Tool[];
    assert.ok(tools.length >= 105 && tools.length <= 512);
    assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length);
    for (const name of [...admission.read_tools, ...admission.write_tools])
      assert.ok(tools.some((tool) => tool.name === name), `published ${name}`);
    return tools;
  })());
}

test("published provider schemas fit discovery without schema or permission loss", async () => {
  const all = await publishedCatalog();
  const access = new Map([
    ...admission.read_tools.map((name) => [name, "read"] as const),
    ...admission.write_tools.map((name) => [name, "write"] as const),
  ]);
  const reviewed = all.filter((tool) => access.has(tool.name));
  const wireBytes = (tools: Tool[]) => Buffer.byteLength(
    JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools } }),
  );
  const outputSchemas = all.map((tool) => JSON.stringify(tool.outputSchema));
  console.log("PUBLISHED_SUBNET_CATALOG", JSON.stringify({
    package: "@loopover/contract@3.21.2",
    provider_sdk: "1.29.0",
    compiled_contracts: all.length,
    admitted: reviewed.length,
    admitted_wire_bytes: wireBytes(reviewed),
    conservative_wire_bytes: wireBytes(all),
    per_response_limit: MAX_RESPONSE_BYTES,
    output_schemas: outputSchemas.length,
    distinct_output_schemas: new Set(outputSchemas).size,
    provider_requests: 0,
  }));
  for (const tools of [reviewed, all]) {
    const methods: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.method === "GET") return new Response(null, { status: 405 });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      const message = JSON.parse(String(init?.body));
      methods.push(message.method);
      if (message.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      const result = message.method === "initialize" ? {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "published-contract-fixture", version: "3.21.2" },
      } : { tools };
      return Response.json({ jsonrpc: "2.0", id: message.id, result });
    };
    const result = await runSubnetMcp({
      url: endpoint,
      readTools: admission.read_tools,
      writeTools: admission.write_tools,
      timeoutMs: 15_000,
      fetchImpl,
      isUnsafeUrl: async () => false,
    }, { kind: "discover" });
    assert.deepEqual(result, {
      kind: "discover",
      tools: reviewed.map((tool) => ({ ...tool, access: access.get(tool.name) })),
    });
    assert.deepEqual(methods, ["initialize", "notifications/initialized", "tools/list"]);
  }
}, 120_000);
