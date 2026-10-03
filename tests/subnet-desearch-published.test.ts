// Existing remote CI only: checksum-pinned official provider source and locked
// packages, no install hooks. The provider executes in an empty-environment,
// permission-restricted process with fixture-only fetch and no sockets/files.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { posix } from "node:path";
import { TextDecoder } from "node:util";
import { gunzipSync } from "node:zlib";
import { build } from "esbuild";
import { test } from "vitest";
import { handleMcpRequest } from "../src/mcp-server.ts";
import { jsonBody, mockEnv, type Row } from "./row-type.ts";
import { desearchCases } from "./fixtures/desearch-cases.ts";

const require = createRequire(import.meta.url);
const revision = "a99cfecd5d9242c407f1cca9ea73c2b2abec2c42";
const sources = [
  { name: "http", sha: "9f6b9cd44eb79e90fe5dae7080d9653ecdcafaaa166d28247a66e5e7055b51c5" },
  { name: "server", sha: "6118788abe42457f6d42a60bf94216825747e519eb88672ae419980533475ce4" },
  { name: "tool-sources", sha: "aa2d2a52a300f76a8849fde72a595c57d507a2cf27a5bff398e062ed75600d05" },
] as const;
// Exact package-lock versions from the pinned official MCP repository.
const packages = [
  { id: "sdk", url: "https://registry.npmjs.org/@modelcontextprotocol/sdk/-/sdk-1.30.1.tgz", integrity: "H2HxLvC3HDNybePJaLdSrU1hhUK5iQw+WvV1b01myFyI7sdVGe1u/IPTE5D9fGCiJDVtgMV/lmFkQXLmQyIFYA==" },
  { id: "zod3", url: "https://registry.npmjs.org/zod/-/zod-3.24.4.tgz", integrity: "OdqJE9UDRPwWsrHjLN2F8bPxvwJBK22EHLWtanu0LSYr5YqzsaaW3RMgmjwr8Rypg5k+meEJdSPXJZXE/yqOMg==" },
  { id: "zod4", url: "https://registry.npmjs.org/zod/-/zod-4.6.5.tgz", integrity: "v5l/aFXZQeai4awLbOpSoHecE9UiMrnfx75tEXLjNonXVARxQ5mOeipTjROUchszUNCqnE+hqAMujRsRHsut2Q==" },
  { id: "jsonschema", url: "https://registry.npmjs.org/zod-to-json-schema/-/zod-to-json-schema-3.25.2.tgz", integrity: "O/PgfnpT1xKSDeQYSCfRI5Gy3hPf91mKVDuYLUHZJMiDFptvP41MSnWofm8dnCm0256ZNfZIM7DSzuSMAFnjHA==" },
  { id: "desearch", url: "https://registry.npmjs.org/desearch-js/-/desearch-js-1.5.0.tgz", integrity: "wWiv4kNFVrtgBJGg1zXEiizHZy2vFek7CA8XPIBwN+LkvwPM3sUsF/YAcKGBfFueAq2Op2lf7QGowr4X48VpkQ==" },
] as const;
const surface = JSON.parse(readFileSync(new URL("../registry/subnets/desearch.json", import.meta.url), "utf8")).surfaces.find((row: Row) => row.id === "sn-22-desearch-mcp") as Row;
const decode = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
function download(url: string, maximum: number): Buffer {
  assert.equal(process.env.CI, "true");
  return execFileSync("curl", ["--fail", "--silent", "--show-error", "--max-time", "30", "--retry", "2", "--retry-delay", "1", "--max-filesize", String(maximum), url], { maxBuffer: maximum, timeout: 100_000 });
}
function unpack(blob: Buffer, id: string, integrity: string, files: Map<string, string>): void {
  assert.equal(createHash("sha512").update(blob).digest("base64"), integrity, id + " package checksum");
  const tar = gunzipSync(blob, { maxOutputLength: 32 * 1024 * 1024 });
  let count = 0;
  const names = new Set<string>();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
    assert.match(sizeText, /^[0-7]+$/);
    const size = Number.parseInt(sizeText, 8);
    assert.ok(size <= 4 * 1024 * 1024 && offset + 512 + size <= tar.length);
    assert.ok(header[156] === 0 || header[156] === 48, "regular files only");
    assert.match(name, /^package\/[a-zA-Z0-9_./@-]+$/);
    assert.ok(!name.includes("..") && !names.has(name));
    names.add(name);
    assert.ok(++count <= 4096);
    if (/\.(?:[cm]?js|json)$/.test(name)) files.set(id + "/" + name, decode(tar.subarray(offset + 512, offset + 512 + size)));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(count > 0);
}
async function publishedProvider(): Promise<Row> {
  const files = new Map<string, string>();
  for (const source of sources) {
    const bytes = download("https://raw.githubusercontent.com/Desearch-ai/mcp-desearch/" + revision + "/src/" + source.name + ".ts", 65_536);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), source.sha);
    files.set("provider/" + source.name + ".js", decode(bytes));
  }
  for (const item of packages) unpack(download(item.url, 8 * 1024 * 1024), item.id, item.integrity, files);
  files.set("mock/undici", 'export const fetch = (...args) => globalThis.__desearchFetch(...args);');
  files.set("mock/http", 'export function createServer() { throw Error("fixture sockets forbidden"); }');
  const bundled = await build({
    entryPoints: ["tests/fixtures/desearch-provider-runtime.ts"], bundle: true, write: false, platform: "browser", format: "iife", globalName: "desearchFixture",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{
      name: "checksum-pinned-desearch",
      setup(plugin) {
        plugin.onResolve({ filter: /^pinned-desearch-http$/ }, () => ({ path: "provider/http.js", namespace: "published" }));
        plugin.onResolve({ filter: /.*/, namespace: "published" }, (args) => {
          let path: string;
          if (args.path === "node:http") path = "mock/http";
          else if (args.path === "undici") path = "mock/undici";
          else if (args.path === "desearch-js") path = "desearch/package/dist/index.mjs";
          else if (args.path.startsWith("@modelcontextprotocol/sdk/")) path = "sdk/package/dist/esm/" + args.path.slice("@modelcontextprotocol/sdk/".length);
          else if (/^zod(?:\/|$)/.test(args.path)) {
            path = args.importer.startsWith("provider/")
              ? "zod3/package/lib/index.mjs"
              : "zod4/package/" + (args.path === "zod" ? "index.js" : args.path.slice(4) + "/index.js");
          } else if (args.path === "zod-to-json-schema") path = "jsonschema/package/dist/esm/index.js";
          else if (/^(?:ajv(?:\/|$)|ajv-formats(?:\/|$)|eventsource-parser(?:\/|$))/.test(args.path)) return { path: require.resolve(args.path), namespace: "file" };
          else {
            assert.ok(args.path.startsWith("."), "no unreviewed upstream capabilities: " + args.path);
            path = posix.normalize(posix.join(posix.dirname(args.importer), args.path));
          }
          assert.ok(files.has(path), "only pinned modules: " + path);
          return { path, namespace: "published" };
        });
        plugin.onLoad({ filter: /.*/, namespace: "published" }, (args) => ({ contents: files.get(args.path)!, loader: args.path.startsWith("provider/") ? "ts" : args.path.endsWith(".json") ? "json" : "js" }));
      },
    }],
  });
  assert.equal(bundled.outputFiles.length, 1);
  const code = bundled.outputFiles[0].text + "\ndesearchFixture.qualifyDesearch()";
  assert.ok(Buffer.byteLength(code) < 8 * 1024 * 1024);
  const runner = [
    'import { runInNewContext } from "node:vm";',
    'import { webcrypto } from "node:crypto";',
    'let source = ""; process.stdin.setEncoding("utf8");',
    'for await (const chunk of process.stdin) { source += chunk; if (Buffer.byteLength(source) > 8 * 1024 * 1024) throw Error("source budget"); }',
    'const sandbox = { Request, Response, Headers, URL, URLSearchParams, AbortController, AbortSignal, ReadableStream, WritableStream, TransformStream, TextEncoder, TextDecoder, setTimeout, clearTimeout, crypto: webcrypto, console: { error: (...args) => { throw Error("provider error: " + args.join(" ")); } }, fetch: () => { throw Error("fixture network forbidden"); } };',
    'const result = await runInNewContext(source, sandbox, { timeout: 20000, contextCodeGeneration: { strings: false, wasm: false } });',
    'const output = JSON.stringify(result); if (Buffer.byteLength(output) > 2 * 1024 * 1024) throw Error("result budget"); process.stdout.write(output);',
  ].join("\n");
  const output = execFileSync(process.execPath, ["--permission", "--disable-proto=throw", "--input-type=module", "-e", runner], { input: code, env: {} as NodeJS.ProcessEnv, maxBuffer: 2 * 1024 * 1024, timeout: 30_000 });
  return JSON.parse(decode(output)) as Row;
}
test.skipIf(process.env.CI !== "true")("all official Desearch tools preserve provider requests and results through the public SDK route", async () => {
  assert.ok(surface);
  assert.deepEqual([...surface.mcp.read_tools].sort(), desearchCases.map((row) => row.name).sort());
  assert.deepEqual(surface.mcp.write_tools, []);
  assert.equal(surface.mcp.public_discovery, true);
  assert.equal(surface.probe.enabled, false);
  const published = await publishedProvider();
  const upstream: Row[] = [];
  let selected = published.results[0];
  let quota = false;
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith("https://cloudflare-dns.com/dns-query")) return Response.json({ Answer: [{ type: 1, data: "18.160.0.1" }] });
    assert.equal(url, surface.url);
    const credential = new Headers(init?.headers).get("x-api-key");
    if (init?.method === "GET") {
      const wire = credential ? published.getKey : published.getPublic;
      return Response.json(wire.body, { status: wire.status, headers: wire.headers });
    }
    const message = JSON.parse(String(init?.body)) as Row;
    upstream.push({ message, credential });
    let wire: Row;
    if (message.method === "initialize") wire = published.initialized;
    else if (message.method === "notifications/initialized") wire = published.notification;
    else if (message.method === "tools/list") wire = published.catalog;
    else {
      assert.equal(message.method, "tools/call");
      assert.equal(credential, "fixture-key-1");
      assert.equal(message.params.name, selected.name);
      assert.deepEqual(message.params.arguments, selected.arguments);
      wire = quota ? published.quota : selected.wire;
    }
    return new Response(wire.body ? JSON.stringify({ ...wire.body, id: message.id }) : null, { status: wire.status, headers: wire.headers });
  };
  const readArtifact = async (_env: unknown, path: string) => path === "/metagraph/surfaces.json" || path === "/metagraph/operational-surfaces.json"
    ? { ok: true, data: { surfaces: [{ ...surface, netuid: 22 }] } }
    : { ok: false, status: 404 };
  const call = async (name: string, arguments_: Row) => {
    const response = await handleMcpRequest(new Request("https://metagraph.sh/mcp", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: arguments_ } }),
    }), mockEnv(), { readArtifact });
    return (await jsonBody(response)).result as Row;
  };
  try {
    const catalog = await call("discover_subnet_mcp", { surface_id: surface.id });
    assert.equal(catalog.isError, false);
    assert.deepEqual(catalog.structuredContent.tools.map((row: Row) => row.name).sort(), desearchCases.map((row) => row.name).sort());
    assert.ok(upstream.every((row) => row.credential === null));
    for (const row of published.results) {
      selected = row;
      const result = await call("read_subnet_mcp", { surface_id: surface.id, tool_name: row.name, arguments: row.arguments, credential: "fixture-key-1" });
      assert.equal(result.isError, false);
      const native = row.wire.body.result.content;
      assert.deepEqual(result.content.slice(0, native.length), native);
      assert.equal(result.structuredContent.tool_name, row.name);
      assert.ok(!JSON.stringify(result).includes("fixture-key-1"));
    }
    const before = upstream.length;
    for (const name of ["read_subnet_mcp", "write_subnet_mcp"]) {
      const denied = await call(name, { surface_id: surface.id, tool_name: "web-search", arguments: desearchCases[2].arguments });
      assert.equal(denied.structuredContent.error.code, "auth_required");
    }
    assert.equal(upstream.length, before);
    selected = published.results.find((row: Row) => row.name === "web-search");
    const deniedWrite = await call("write_subnet_mcp", { surface_id: surface.id, tool_name: selected.name, arguments: selected.arguments, credential: "fixture-key-1" });
    assert.equal(deniedWrite.structuredContent.error.code, "operation_not_allowed");
    assert.equal(upstream.length, before);
    quota = true;
    const error = await call("read_subnet_mcp", { surface_id: surface.id, tool_name: selected.name, arguments: selected.arguments, credential: "fixture-key-1" });
    assert.equal(error.isError, true);
    assert.equal(error.structuredContent.upstream_is_error, true);
    assert.deepEqual(error.content.slice(0, published.quota.body.result.content.length), published.quota.body.result.content);
    console.log("DESEARCH_PUBLISHED_QUALIFICATION", JSON.stringify({ source_revision: revision, provider_sdk: "1.30.1", provider_rest_sdk: "1.5.0", admitted_tools: published.results.length, native_result_bytes: published.results.reduce((sum: number, row: Row) => sum + Buffer.byteLength(JSON.stringify(row.wire.body.result.content)), 0), fixture_api_requests_per_tool: 1, key_isolation: true, keyless_execution_denied: true, write_denied_before_traffic: true, quota_error_preserved: true, production_requests: published.production_requests }));
  } finally { globalThis.fetch = original; }
}, 240_000);
