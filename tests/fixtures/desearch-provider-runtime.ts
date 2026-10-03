// Bundled and executed only by subnet-desearch-published.test.ts on remote CI.
// The pinned HTTP handler and its actual MCP/REST SDKs receive fixture requests.
import { desearchCases, desearchJsonResult, desearchTextResult } from "./desearch-cases.ts";
import type { Row } from "../row-type.ts";

const provider = require("pinned-desearch-http") as {
  handleMcpHttpRequest(request: Request): Promise<Response>;
};
function check(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
function equal(actual: unknown, expected: unknown, label: string): void {
  check(JSON.stringify(actual) === JSON.stringify(expected), label + ": " + JSON.stringify(actual));
}
type ApiCall = { url: string; method: string; headers: Record<string, string>; body: string | null };
type Wire = { status: number; headers: Record<string, string>; body: Row | null };

export async function qualifyDesearch() {
  const calls: ApiCall[] = [];
  let quota = false;
  Reflect.set(globalThis, "__desearchFetch", async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    check(url.origin === "https://api.desearch.ai", "only fixture API origin");
    const method = init?.method ?? "GET";
    check(desearchCases.some((row) => row.path === url.pathname && row.method === method), "only reviewed REST routes");
    calls.push({ url: url.toString(), method, headers: Object.fromEntries(new Headers(init?.headers)), body: typeof init?.body === "string" ? init.body : null });
    if (quota) return Response.json({ detail: "fixture quota exceeded" }, { status: 429 });
    return url.pathname === "/web/extract" || url.pathname === "/web/crawl"
      ? new Response(desearchTextResult, { headers: { "content-type": "text/plain; charset=utf-8" } })
      : Response.json(desearchJsonResult);
  });
  const request = async (method: string, params: Row, key?: string): Promise<Wire> => {
    const response = await provider.handleMcpHttpRequest(new Request("https://mcp.desearch.ai/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25", ...(key ? { "x-api-key": key } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", ...(method.startsWith("notifications/") ? {} : { id: 1 }), method, params }),
    }));
    const text = await response.text();
    return { status: response.status, headers: Object.fromEntries(response.headers), body: text ? JSON.parse(text) : null };
  };
  const initialized = await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fixture-bridge", version: "1" } });
  equal(initialized.status, 200, "public initialize");
  const catalog = await request("tools/list", {});
  equal(catalog.status, 200, "public catalog");
  equal(catalog.body?.result.tools.map((tool: Row) => tool.name).sort(), desearchCases.map((row) => row.name).sort(), "all 15 tools");
  equal(calls.length, 0, "catalog performs no REST requests");
  const notification = await request("notifications/initialized", {});
  equal(notification.status, 202, "public initialized notification");
  const get = async (key?: string): Promise<Wire> => {
    const response = await provider.handleMcpHttpRequest(new Request("https://mcp.desearch.ai/mcp", { headers: key ? { "x-api-key": key } : {} }));
    return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.json() as Row };
  };
  const getPublic = await get();
  const getKey = await get("fixture-key-1");
  equal(getPublic.status, 401, "keyless GET");
  equal(getKey.status, 405, "stateless authenticated GET");
  const keyless = await request("tools/call", { name: "web-search", arguments: desearchCases[2].arguments });
  equal(keyless.status, 401, "keyless execution denied");
  equal(calls.length, 0, "keyless execution performs no REST requests");
  const results = [];
  for (const row of desearchCases) {
    calls.length = 0;
    const wire = await request("tools/call", { name: row.name, arguments: row.arguments }, "fixture-key-1");
    equal(wire.status, 200, row.name + " status");
    check(!wire.body?.result.isError, row.name + " succeeds");
    equal(calls.length, 1, row.name + " REST request count");
    const api = calls[0]!;
    equal(api.method, row.method, row.name + " REST method");
    equal(new URL(api.url).pathname, row.path, row.name + " REST path");
    equal(new Headers(api.headers).get("authorization"), "fixture-key-1", "caller key");
    const expected = row.name === "extract" || row.name === "web-crawl" ? desearchTextResult : desearchJsonResult;
    equal(wire.body?.result.content, [{ type: "text", text: JSON.stringify(expected, null, 2) }], row.name + " native result bytes");
    if (row.name === "x-posts-by-urls") equal(new URL(api.url).searchParams.getAll("urls"), row.arguments.urls, "repeated URLs");
    if (row.name === "x-search") {
      equal(new URL(api.url).searchParams.get("verified"), "false", "falsy boolean");
      equal(new URL(api.url).searchParams.get("min_likes"), "0", "falsy number");
      equal(new URL(api.url).searchParams.get("query"), row.arguments.query, "Unicode query");
    }
    if (row.name === "ai-search") equal(JSON.parse(api.body!).streaming, false, "nonstreaming provider call");
    results.push({ name: row.name, arguments: row.arguments, wire, api });
  }
  calls.length = 0;
  await request("tools/call", { name: "web-search", arguments: desearchCases[2].arguments }, "fixture-key-2");
  equal(new Headers(calls[0]!.headers).get("authorization"), "fixture-key-2", "request key isolation");
  quota = true;
  calls.length = 0;
  const quotaResult = await request("tools/call", { name: "web-search", arguments: desearchCases[2].arguments }, "fixture-key-1");
  equal(quotaResult.status, 200, "native quota transport status");
  equal(quotaResult.body?.result.isError, true, "native quota execution error");
  equal(calls.length, 1, "quota request count");
  return { initialized, catalog, notification, getPublic, getKey, keyless, results, quota: quotaResult, production_requests: 0 };
}
