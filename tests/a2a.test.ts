// #11175: the A2A surface -- the card, and the endpoint the card points at.
//
// The contract under test is honesty: every capability the card advertises
// answers, and every method the server does not support answers the SPEC'S
// code for that, not a router 404.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  agentCardResponse,
  buildAgentCard,
  handleA2ARequest,
  A2A_CARD_PATH,
  A2A_ENDPOINT_PATH,
} from "../workers/request-handlers/a2a.ts";
import { MCP_SERVER_VERSION } from "../src/mcp-server.ts";
import { mockEnv, type Row } from "./row-type.ts";
import { handleRequest } from "../workers/api.ts";

const CARD_URL = `https://api.metagraph.sh${A2A_CARD_PATH}`;
const RPC_URL = `https://api.metagraph.sh${A2A_ENDPOINT_PATH}`;

/** An env the AI gate accepts; the ask itself is injected per test. The gate
 * needs the kill-switch AND the bindings (aiEnabled = flag && configured);
 * the limiter binding stays absent, which fails open like every limiter. */
const aiEnv = () =>
  mockEnv({
    METAGRAPH_ENABLE_AI: "true",
    // aiConfigured demands a callable AI.run and a truthy VECTORIZE; the run
    // itself is never reached because askQuestionImpl is injected.
    AI: { run: async () => ({}) } as never,
    VECTORIZE: {} as never,
  });

const askResult = {
  question: "q",
  answer: "SN64 serves inference [1].",
  citations: [
    {
      ref: 1,
      score: 0.91,
      title: "Chutes",
      netuid: 64,
      slug: "sn-64",
      url: "https://metagraph.sh/subnets/64",
    },
  ],
  context_count: 1,
  model: "test-model",
};

const rpc = (body: unknown, env = aiEnv(), deps = {}) =>
  handleA2ARequest(
    new Request(RPC_URL, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    env,
    { askQuestionImpl: async () => askResult, ...deps },
  );

describe("the agent card", () => {
  test("advertises exactly what the endpoint implements", async () => {
    const res = await agentCardResponse(new Request(CARD_URL));
    assert.equal(res.status, 200);
    const card = (await res.json()) as Row;
    assert.equal(card.protocolVersion, "0.3.0");
    assert.equal(card.url, `https://api.metagraph.sh${A2A_ENDPOINT_PATH}`);
    assert.equal(card.preferredTransport, "JSONRPC");
    assert.equal(card.version, MCP_SERVER_VERSION);
    // ONE skill. The 240 MCP tools are tools; advertising each as an A2A
    // skill would promise a delegation interface nobody built.
    const skills = card.skills as Row[];
    assert.equal(skills.length, 1);
    assert.equal(skills[0].id, "ask");
    // The card must not promise the lifecycles the endpoint refuses below.
    assert.deepEqual(card.capabilities, {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    });
  });

  test("card requests are conditional (etag round trip)", async () => {
    const first = await agentCardResponse(new Request(CARD_URL));
    const etag = first.headers.get("etag");
    assert.ok(etag);
    const second = await agentCardResponse(
      new Request(CARD_URL, { headers: { "if-none-match": etag } }),
    );
    assert.equal(second.status, 304);
    const head = await agentCardResponse(
      new Request(CARD_URL, { method: "HEAD" }),
    );
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  });

  test("buildAgentCard stamps the version it was handed", () => {
    assert.equal(buildAgentCard("9.9.9").version, "9.9.9");
  });
});

describe("message/send", () => {
  test("answers a Message with the ask answer and structured citations", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 7,
      method: "message/send",
      params: {
        message: {
          role: "user",
          parts: [{ kind: "text", text: "Which subnets serve inference?" }],
          messageId: "m1",
        },
      },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    assert.equal(body.id, 7);
    const result = body.result as Row;
    assert.equal(result.kind, "message");
    assert.equal(result.role, "agent");
    const parts = result.parts as Row[];
    assert.equal(parts[0].kind, "text");
    assert.equal(parts[0].text, askResult.answer);
    assert.equal(parts[1].kind, "data");
    assert.deepEqual((parts[1].data as Row).citations, askResult.citations);
  });

  test("joins multiple text parts into one question", async () => {
    let seen = "";
    const res = await rpc(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: {
          message: {
            parts: [
              { kind: "text", text: "Context: subnet 3." },
              { kind: "text", text: "What is the burn?" },
            ],
          },
        },
      },
      aiEnv(),
      {
        askQuestionImpl: async (_env: unknown, q: unknown) => {
          seen = String(q);
          return askResult;
        },
      },
    );
    assert.equal(res.status, 200);
    assert.equal(seen, "Context: subnet 3.\nWhat is the burn?");
  });

  test("an empty message is invalid_params; a file-only one is the content-type code", async () => {
    const empty = await rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "message/send",
      params: { message: { parts: [] } },
    });
    assert.equal(((await empty.json()) as Row).error?.["code"], -32602);

    const fileOnly = await rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "message/send",
      params: {
        message: { parts: [{ kind: "file", file: { uri: "x://y" } }] },
      },
    });
    // -32005 ContentTypeNotSupportedError: the caller sent SOMETHING, in a
    // mode this skill does not accept -- a different failure from sending
    // nothing, and the spec has a code for each.
    assert.equal(((await fileOnly.json()) as Row).error?.["code"], -32005);
  });

  test("a success with no request id answers id: null, per JSON-RPC", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      method: "message/send",
      params: { message: { parts: [{ kind: "text", text: "q" }] } },
    });
    const body = (await res.json()) as Row;
    assert.equal(body.id, null);
    assert.equal((body.result as Row).kind, "message");
  });

  test("without an injected ask, the real askQuestion runs and its failure is contained", async () => {
    // The stub env has a callable AI.run and an empty VECTORIZE, so the real
    // pipeline fails inside retrieval -- proving the production arm of the
    // dependency seam is wired and that its failure is a JSON-RPC error
    // rather than an unhandled throw.
    const res = await handleA2ARequest(
      new Request(RPC_URL, {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 11,
          method: "message/send",
          params: { message: { parts: [{ kind: "text", text: "q" }] } },
        }),
      }),
      aiEnv(),
    );
    assert.equal(((await res.json()) as Row).error?.["code"], -32603);
  });

  test("a message with no parts at all is invalid_params, not a crash", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 10,
      method: "message/send",
      params: {},
    });
    assert.equal(((await res.json()) as Row).error?.["code"], -32602);
  });

  test("a non-Error throw still answers a generic error, and id defaults to null", async () => {
    const res = await rpc(
      {
        jsonrpc: "2.0",
        method: "message/send",
        params: { message: { parts: [{ kind: "text", text: "q" }] } },
      },
      aiEnv(),
      {
        askQuestionImpl: async () => {
          throw "string failure";
        },
      },
    );
    const body = (await res.json()) as Row;
    assert.equal((body.error as Row).code, -32603);
    assert.equal((body.error as Row).message, "ask failed");
    assert.equal(body.id, null);
  });

  test("an ask failure is a JSON-RPC error, not a thrown 500", async () => {
    const res = await rpc(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "message/send",
        params: { message: { parts: [{ kind: "text", text: "q" }] } },
      },
      aiEnv(),
      {
        askQuestionImpl: async () => {
          throw new Error("model unavailable");
        },
      },
    );
    const body = (await res.json()) as Row;
    assert.equal((body.error as Row).code, -32603);
    assert.match(String((body.error as Row).message), /model unavailable/);
  });
});

describe("the methods this server refuses, with the spec's own codes", () => {
  test("streaming methods answer UnsupportedOperationError (-32004)", async () => {
    for (const method of ["message/stream", "tasks/resubscribe"]) {
      const res = await rpc({ jsonrpc: "2.0", id: 5, method, params: {} });
      assert.equal(((await res.json()) as Row).error?.["code"], -32004, method);
    }
  });

  test("task methods answer TaskNotFoundError (-32001)", async () => {
    // message/send returns a bare Message, so no task ever exists.
    for (const method of ["tasks/get", "tasks/cancel"]) {
      const res = await rpc({ jsonrpc: "2.0", id: 6, method, params: {} });
      assert.equal(((await res.json()) as Row).error?.["code"], -32001, method);
    }
  });

  test("an unknown method is -32601", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 8,
      method: "agent/frobnicate",
    });
    assert.equal(((await res.json()) as Row).error?.["code"], -32601);
    const missing = await rpc({ jsonrpc: "2.0", id: 9 });
    const err = ((await missing.json()) as Row).error as Row;
    assert.equal(err.code, -32601);
    assert.match(String(err.message), /null/);
  });
});

describe("transport guards", () => {
  test("GET is refused with 405 and a pointer at the card", async () => {
    const res = await handleA2ARequest(new Request(RPC_URL), aiEnv());
    assert.equal(res.status, 405);
    assert.match(
      String(((await res.json()) as Row).error?.["message"]),
      /agent-card\.json/,
    );
  });

  test("a deployment without AI answers 503, not a fake answer", async () => {
    const res = await handleA2ARequest(
      new Request(RPC_URL, { method: "POST", body: "{}" }),
      mockEnv(),
    );
    assert.equal(res.status, 503);
  });

  test("malformed JSON is a parse error", async () => {
    const res = await handleA2ARequest(
      new Request(RPC_URL, { method: "POST", body: "not json" }),
      aiEnv(),
      { askQuestionImpl: async () => askResult },
    );
    assert.equal(((await res.json()) as Row).error?.["code"], -32700);
  });

  test("a denied rate limit is a 429, before any body is read", async () => {
    // The limiter binding present and saying no -- the same tiered config
    // /api/v1/ask reads, exercised through the real applyTieredRateLimit.
    const denied = aiEnv();
    (denied as unknown as Row).AI_RATE_LIMITER = {
      limit: async () => ({ success: false }),
    };
    const res = await handleA2ARequest(
      new Request(RPC_URL, { method: "POST", body: "{}" }),
      denied,
    );
    assert.equal(res.status, 429);
  });

  test("an oversized body is refused at the bound", async () => {
    const res = await handleA2ARequest(
      new Request(RPC_URL, {
        method: "POST",
        body: "x".repeat(70_000),
        headers: { "content-length": "70000" },
      }),
      aiEnv(),
    );
    assert.equal(res.status, 413);
  });
});

describe("router wiring", () => {
  // Through the REAL router, not the handler directly: these are the lines
  // workers/api.ts adds, and the thing they must prove is that the well-known
  // path and the endpoint dispatch to this module at all.
  test("the card and the endpoint are reachable through handleRequest", async () => {
    const card = await handleRequest(
      new Request(CARD_URL),
      mockEnv(),
      {} as never,
    );
    assert.equal(card.status, 200);
    assert.equal(
      ((await card.json()) as Row).url,
      `https://api.metagraph.sh${A2A_ENDPOINT_PATH}`,
    );

    // No AI bindings on this env, so the endpoint answers its 503 -- which is
    // exactly the proof the route reached the handler rather than a 404.
    const rpcRes = await handleRequest(
      new Request(RPC_URL, { method: "POST", body: "{}" }),
      mockEnv(),
      {} as never,
    );
    assert.equal(rpcRes.status, 503);
  });
});
