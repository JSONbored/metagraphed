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
        export default { async fetch(request) {
          globalThis.fetch = async () => { throw new Error('External network forbidden'); };
          const { body_base64, content_type, query_values } = await request.json();
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
          const document = { components: { requestBodies: { upload: { content: { 'multipart/form-data': {} } } } } };
          const resolved = resolveLocalRequestBody(document, { $ref: '#/components/requestBodies/upload' });
          if (!matchesBinaryRequestMediaType(content_type, Object.keys(resolved.content))) throw new Error('Undeclared MIME');
          const calls = [];
          const result = await callSubnetSurface({ url: 'https://subnet.example/api' }, {
            path: '/upload', method: 'POST', body, contentType: content_type,
            isUnsafeUrl: async () => false,
            fetchImpl: async (url, init) => {
              if (String(url) !== 'https://subnet.example/upload') throw new Error('Unmocked provider URL');
              if (init.body !== body) throw new Error('Unexpected body copy');
              const outgoing = new Request(url, init);
              calls.push({ method: outgoing.method, contentType: outgoing.headers.get('content-type'), bytes: Array.from(new Uint8Array(await outgoing.arrayBuffer())) });
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
