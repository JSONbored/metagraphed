import assert from "node:assert/strict";
import { isBuiltin } from "node:module";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, test } from "vitest";
import type { Row } from "./row-type.ts";

let runtime: Miniflare;
beforeAll(async () => {
  const bundled = await build({
    stdin: {
      contents: `
        import { callSubnetSurface, matchSchemaOperation } from './src/call-subnet-surface.ts';
        import { serializeDeclaredQuery } from './src/subnet-http-query.ts';
        import { resolveLocalRequestBody, matchesBinaryRequestMediaType } from './src/subnet-http-body.ts';
        import { resolveSwaggerRequestBody } from './src/subnet-swagger-body.ts';
        import { serializeDeclaredHttpParameters } from './src/subnet-http-parameters.ts';
        export default { async fetch(request) {
          globalThis.fetch = async () => { throw new Error('External network forbidden'); };
          const { body_base64, content_type, query_values, swagger_body, header_values, cookie_values } = await request.json();
          if (header_values || cookie_values) {
            const pathItem = { get: { parameters: [
              { name: 'X-JSON', in: 'header', content: { 'application/json': {} } },
              { name: 'color', in: 'cookie', style: 'cookie', schema: {} },
              { name: 'keep', in: 'cookie', schema: {} }
            ] } };
            const document = { openapi: '3.2.0', paths: { '/params': pathItem } };
            const match = matchSchemaOperation(document, '/params', 'GET', true);
            const fields = serializeDeclaredHttpParameters(document, match.pathItem, match.operation, header_values, cookie_values);
            const calls = [];
            const result = await callSubnetSurface({ url: 'https://subnet.example/api' }, {
              path: '/params', method: 'GET', requestHeaders: fields.headers, serializedCookies: fields.cookies, parameterRedactions: fields.redactions,
              credential: { location: 'cookie', name: 'token', value: 'fixture-secret' },
              isUnsafeUrl: async () => false,
              fetchImpl: async (url, init) => {
                const outgoing = new Request(url, init);
                if (outgoing.url !== 'https://subnet.example/params') throw new Error('Unmocked provider URL');
                calls.push({ method: outgoing.method, json: outgoing.headers.get('x-json'), cookie: outgoing.headers.get('cookie') });
                return Response.json({ accepted: true });
              }
            });
            return Response.json({ result, calls });
          }
          if (query_values) {
            const pathItem = { get: { parameters: [
              { name: 'ids', in: 'query', schema: { type: 'array' }, explode: false },
              { name: 'color', in: 'query', schema: { type: 'object' } },
              { name: 'filter', in: 'query', content: { 'application/json': { schema: {} } } }
            ] } };
            const document = { paths: { '/query': { $ref: '#/pathItems/0' } }, pathItems: [pathItem] };
            const match = matchSchemaOperation(document, '/query', 'GET', true);
            const calls = [];
            const result = await callSubnetSurface({ url: 'https://subnet.example/api' }, {
              path: '/query', method: 'GET',
              serializedQuery: serializeDeclaredQuery(document, match.pathItem, match.operation, query_values),
              credential: { location: 'query', name: 'api_key', value: 'fixture +&雪' },
              isUnsafeUrl: async () => false,
              fetchImpl: async (url, init) => {
                const outgoing = new Request(url, init);
                if (new URL(outgoing.url).origin !== 'https://subnet.example') throw new Error('Unmocked provider URL');
                calls.push({ method: outgoing.method, url: outgoing.url });
                return Response.json({ accepted: true });
              }
            });
            return Response.json({ result, calls });
          }
          const body = Buffer.from(body_base64, 'base64');
          const document = swagger_body
            ? { swagger: '2.0', consumes: ['multipart/form-data'], parameters: { file: { name: 'file', in: 'formData', type: 'file' } }, paths: { '/upload': { parameters: [{ $ref: '#/parameters/file' }], post: {} } } }
            : { components: { requestBodies: { upload: { content: { 'multipart/form-data': {} } } } } };
          const match = swagger_body ? matchSchemaOperation(document, '/upload', 'POST', true) : null;
          const resolved = swagger_body
            ? resolveSwaggerRequestBody(document, match.pathItem, match.operation)
            : resolveLocalRequestBody(document, { $ref: '#/components/requestBodies/upload' });
          if (!matchesBinaryRequestMediaType(content_type, Object.keys(resolved.content))) throw new Error('Undeclared MIME');
          const calls = [];
          const result = await callSubnetSurface({ url: 'https://subnet.example/api' }, {
            path: '/upload', method: 'POST', body, contentType: content_type,
            credential: swagger_body ? { location: 'header', name: 'Authorization', value: 'Bearer fixture-token' } : undefined,
            isUnsafeUrl: async () => false,
            fetchImpl: async (url, init) => {
              if (String(url) !== 'https://subnet.example/upload') throw new Error('Unmocked provider URL');
              if (init.body !== body) throw new Error('Unexpected body copy');
              const outgoing = new Request(url, init);
              calls.push({ method: outgoing.method, contentType: outgoing.headers.get('content-type'), bytes: Array.from(new Uint8Array(await outgoing.arrayBuffer())), ...(swagger_body ? { authorization: outgoing.headers.get('authorization') } : {}) });
              return Response.json({ accepted: true });
            }
          });
          return Response.json({ result, calls });
        }};`,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    // Match the deploy builder's native Node bridge for CommonJS dependencies.
    plugins: [
      {
        name: "native-node-requires",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, (args) => {
            if (!isBuiltin(args.path)) return;
            return args.kind === "require-call"
              ? {
                  path: args.path.replace(/^node:/, ""),
                  namespace: "native-node-require",
                }
              : {
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
  });
  runtime = new Miniflare({
    modules: true,
    script: bundled.outputFiles[0].text,
    compatibilityDate: "2026-06-06",
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
  });
}, 60_000);
afterAll(async () => runtime?.dispose());

test("workerd preserves typed JSON header values, raw cookies and credential precedence", async () => {
  const response = await runtime.dispatchFetch("https://worker-fixture.example/", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ header_values: { "x-json": { nested: [0, null, "雪😀"] } }, cookie_values: { color: { token: "wrong", R: "literal%2C" }, keep: "a +&雪" } }),
  });
  assert.equal(response.status, 200);
  const { result, calls } = (await response.json()) as Row;
  assert.equal(result.ok, true); assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].json), { nested: [0, null, "雪😀"] });
  assert.equal(calls[0].cookie, "R=literal%2C; keep=a%20%2B%26%E9%9B%AA; token=fixture-secret");
});

test("workerd sends decoded nonUTF8 multipart bytes with the exact boundary header", async () => {
  const bytes = Buffer.concat([
    Buffer.from(
      '--fixture\r\nContent-Disposition: form-data; name="file"\r\n\r\n',
    ),
    Buffer.from([0, 128, 255]),
    Buffer.from("\r\n--fixture--\r\n"),
  ]);
  const content_type = 'multipart/form-data; boundary="fixture"';
  const response = await runtime.dispatchFetch(
    "https://worker-fixture.example/",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body_base64: bytes.toString("base64"),
        content_type,
      }),
    },
  );
  assert.equal(response.status, 200);
  const { result, calls } = (await response.json()) as Row;
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    { method: "POST", contentType: content_type, bytes: [...bytes] },
  ]);
});

test("workerd forwards joined arrays, exploded objects and JSON query values with credential precedence", async () => {
  const response = await runtime.dispatchFetch(
    "https://worker-fixture.example/",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query_values: {
          ids: ["a,b", "雪 /"],
          color: { api_key: "wrong", flag: false },
          filter: { nested: [0, null] },
        },
      }),
    },
  );
  assert.equal(response.status, 200);
  const { result, calls } = (await response.json()) as Row;
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    {
      method: "GET",
      url: "https://subnet.example/query?ids=a%2Cb,%E9%9B%AA%20%2F&flag=false&filter=%7B%22nested%22%3A%5B0%2Cnull%5D%7D&api_key=fixture+%2B%26%E9%9B%AA",
    },
  ]);
  assert.equal(JSON.stringify(result).includes("fixture"), false);
  assert.equal(JSON.stringify(result).includes("wrong"), false);
});

test("workerd admits inherited Swagger formData and forwards exact file bytes with header auth", async () => {
  const bytes = Buffer.concat([
    Buffer.from(
      '--fixture\r\nContent-Disposition: form-data; name="file"; filename="test.bin"\r\n\r\n',
    ),
    Buffer.from([0, 128, 255]),
    Buffer.from("\r\n--fixture--\r\n"),
  ]);
  const content_type = 'multipart/form-data; boundary="fixture"';
  const response = await runtime.dispatchFetch(
    "https://worker-fixture.example/",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        swagger_body: true,
        body_base64: bytes.toString("base64"),
        content_type,
      }),
    },
  );
  assert.equal(response.status, 200);
  const { result, calls } = (await response.json()) as Row;
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    {
      method: "POST",
      contentType: content_type,
      bytes: [...bytes],
      authorization: "Bearer fixture-token",
    },
  ]);
});
