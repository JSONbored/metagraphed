import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import { handleMcpRequest, MAX_MCP_BODY_BYTES } from "../src/mcp-server.ts";
import {
  handleGraphQLRequest,
  GRAPHQL_MAX_BODY_BYTES,
} from "../src/graphql.ts";

const endpoints = [
  {
    name: "MCP",
    url: "https://metagraph.sh/mcp",
    limit: MAX_MCP_BODY_BYTES,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    handle: (request: Request) => handleMcpRequest(request, {} as Env),
  },
  {
    name: "GraphQL",
    url: "https://metagraph.sh/api/v1/graphql",
    limit: GRAPHQL_MAX_BODY_BYTES,
    body: JSON.stringify({ query: "{ __typename }" }),
    handle: (request: Request) => handleGraphQLRequest(request, {} as Env),
  },
];

for (const endpoint of endpoints) {
  describe(`${endpoint.name} request body limits`, () => {
    function request(body: BodyInit, length: string | null) {
      const headers = new Headers({ "content-type": "application/json" });
      if (length !== null) headers.set("content-length", length);
      return new Request(endpoint.url, {
        method: "POST",
        headers,
        body,
        duplex: "half",
      } as RequestInit);
    }

    for (const length of [
      "",
      "abc",
      "1.5",
      "1e3",
      "0x10",
      "0b10",
      "0o10",
      "+1",
      "-1",
      "-0",
      "NaN",
      "Infinity",
      "1 2",
      "1, 1",
    ]) {
      test(`rejects Content-Length ${JSON.stringify(length)} before acquiring the reader`, async () => {
        const pull = vi.fn((controller) => {
          controller.enqueue(new TextEncoder().encode(endpoint.body));
          controller.close();
        });
        const stream = new ReadableStream({ pull }, { highWaterMark: 0 });
        const req = request(stream, length);
        const getReader = vi.spyOn(req.body!, "getReader");
        const response = await endpoint.handle(req);
        assert.equal(response.status, 400);
        assert.match(await response.text(), /Invalid Content-Length header/);
        assert.equal(getReader.mock.calls.length, 0);
        assert.equal(pull.mock.calls.length, 0);
        assert.equal(req.bodyUsed, false);
      });
    }

    for (const length of [String(endpoint.limit + 1), "9".repeat(400)]) {
      test(`rejects an oversized ${length.length}-digit decimal length before reading`, async () => {
        const pull = vi.fn((controller) => {
          controller.enqueue(new TextEncoder().encode(endpoint.body));
          controller.close();
        });
        const stream = new ReadableStream({ pull }, { highWaterMark: 0 });
        const req = request(stream, length);
        const getReader = vi.spyOn(req.body!, "getReader");
        const response = await endpoint.handle(req);
        assert.equal(response.status, 413);
        assert.equal(getReader.mock.calls.length, 0);
        assert.equal(pull.mock.calls.length, 0);
        assert.equal(req.bodyUsed, false);
      });
    }

    for (const length of [
      null,
      String(endpoint.body.length),
      `000${endpoint.body.length}`,
      "0",
    ]) {
      test(`preserves valid requests with Content-Length ${length}`, async () => {
        const response = await endpoint.handle(request(endpoint.body, length));
        assert.equal(response.status, 200);
        if (endpoint.name === "MCP") {
          assert.deepEqual(await response.json(), {
            jsonrpc: "2.0",
            id: 1,
            result: {},
          });
        } else {
          assert.deepEqual(await response.json(), {
            data: { __typename: "Query" },
          });
        }
      });
    }

    for (const length of [null, String(endpoint.limit)]) {
      test(`accepts exactly the byte limit with Content-Length ${length}`, async () => {
        const body = endpoint.body.padEnd(endpoint.limit, " ");
        const response = await endpoint.handle(request(body, length));
        assert.equal(response.status, 200);
      });
    }

    for (const length of [null, "0", "1"]) {
      test(`cancels an oversized UTF-8 stream with Content-Length ${length}`, async () => {
        // Fewer JS code units than the byte limit: the reader must count bytes.
        const chunk = new TextEncoder().encode("é".repeat(4096));
        let produced = 0;
        const cancel = vi.fn();
        const stream = new ReadableStream(
          {
            pull(controller) {
              produced += chunk.byteLength;
              // Bound the fixture even if streaming enforcement regresses.
              if (produced > endpoint.limit * 2) {
                controller.close();
              } else {
                controller.enqueue(chunk);
              }
            },
            cancel,
          },
          { highWaterMark: 0 },
        );
        const response = await endpoint.handle(request(stream, length));
        assert.equal(response.status, 413);
        assert.equal(cancel.mock.calls.length, 1);
        assert.equal(produced, endpoint.limit + chunk.byteLength);
        assert.equal(stream.locked, false);
      });
    }
  });
}
