import assert from "node:assert/strict";
import { test } from "vitest";
import { d1AdminBatch, d1AdminCredentials } from "../scripts/lib/d1-admin.ts";

const credentials = {
  accountId: "a".repeat(32),
  databaseId: "12345678-1234-1234-1234-123456789012",
  apiToken: "test-credential",
};
const statement = { sql: "SELECT ?", params: ["bound"] };
test("D1 management requires complete credentials and preserves explicit configuration", () => {
  assert.deepEqual(
    d1AdminCredentials({
      CLOUDFLARE_ACCOUNT_ID: credentials.accountId,
      CLOUDFLARE_D1_DATABASE_ID: credentials.databaseId,
      CLOUDFLARE_API_TOKEN: credentials.apiToken,
    }),
    credentials,
  );
  for (const env of [
    {},
    { CLOUDFLARE_ACCOUNT_ID: "../bad" },
    {
      CLOUDFLARE_ACCOUNT_ID: credentials.accountId,
      CLOUDFLARE_D1_DATABASE_ID: "bad",
      CLOUDFLARE_API_TOKEN: "secret",
    },
  ])
    assert.throws(() => d1AdminCredentials(env), /required/);
});
test("D1 management binds parameters to a fixed API origin, denies redirects and bounds time", async () => {
  let calls = 0;
  const results = await d1AdminBatch(
    [statement],
    credentials,
    async (url, init) => {
      calls++;
      assert.equal(
        url,
        `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/d1/database/${credentials.databaseId}/query`,
      );
      assert.equal(init?.redirect, "error");
      assert.equal(init?.method, "POST");
      assert.ok(init?.signal);
      assert.equal(
        new Headers(init.headers).get("authorization"),
        "Bearer test-credential",
      );
      assert.deepEqual(JSON.parse(String(init.body)), { batch: [statement] });
      return Response.json({
        success: true,
        result: [{ success: true, results: [{ value: "bound" }] }],
      });
    },
  );
  assert.equal(calls, 1);
  assert.equal(results[0]?.results[0]?.value, "bound");
});
test("D1 management refuses invalid batch sizes without a request", async () => {
  for (const statements of [[], Array(101).fill(statement)])
    await assert.rejects(
      d1AdminBatch(statements, credentials, async () => {
        throw Error("must not request");
      }),
      /1 to 100/,
    );
});
test("D1 management does not retry or expose credentialed failure responses", async () => {
  let calls = 0;
  await assert.rejects(
    d1AdminBatch([statement], credentials, async () => {
      calls++;
      throw Error(credentials.apiToken);
    }),
    (error) =>
      !String(error).includes(credentials.apiToken) &&
      String(error).includes("verify state"),
  );
  assert.equal(calls, 1);
  for (const response of [
    new Response(credentials.apiToken, { status: 403 }),
    new Response(null, { status: 204 }),
  ])
    await assert.rejects(
      d1AdminBatch([statement], credentials, async () => response),
      /HTTP/,
    );
  for (const body of [
    "invalid",
    "null",
    "{}",
    JSON.stringify({ success: true, result: [] }),
    JSON.stringify({
      success: true,
      result: [{ success: false, results: [] }],
    }),
    JSON.stringify({
      success: true,
      result: [{ success: true, results: null }],
    }),
  ])
    await assert.rejects(
      d1AdminBatch([statement], credentials, async () => new Response(body)),
    );
});
test("D1 management handles chunked Unicode and rejects unbounded responses", async () => {
  const data = new TextEncoder().encode(
    JSON.stringify({
      success: true,
      result: [{ success: true, results: [{ value: "λ" }] }],
    }),
  );
  const response = new Response(
    new ReadableStream({
      start(controller) {
        for (const byte of data) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    }),
  );
  assert.equal(
    (await d1AdminBatch([statement], credentials, async () => response))[0]
      ?.results[0]?.value,
    "λ",
  );
  await assert.rejects(
    d1AdminBatch(
      [statement],
      credentials,
      async () => new Response("x".repeat(4 * 1024 * 1024 + 1)),
    ),
    /4 MiB/,
  );
});

test("D1 HTTP failures retain bounded provider diagnostics and the original status without retry", async () => {
  let calls = 0;
  await assert.rejects(
    d1AdminBatch([statement], credentials, async () => {
      calls++;
      return Response.json(
        {
          success: false,
          errors: [{ code: 10000, message: "  Authentication\n error  " }],
          result: { secret: credentials.apiToken, sql: statement.sql },
        },
        {
          status: 403,
          headers: {
            "cf-ray": "0123456789abcdef-LHR",
            authorization: `Bearer ${credentials.apiToken}`,
            "set-cookie": "private-cookie",
          },
        },
      );
    }),
    (error: unknown) => {
      assert.equal(
        String(error),
        "Error: D1 maintenance request failed with HTTP 403; request_id=0123456789abcdef-LHR; provider_code=10000; provider_message=Authentication error; error_body=json",
      );
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("malformed, non-JSON and unreadable HTTP errors never replace their status or echo response text", async () => {
  const secret = "sensitive-response-content";
  for (const body of ["{", `<html>${secret}</html>`, "null", "{}"])
    await assert.rejects(
      d1AdminBatch(
        [statement],
        credentials,
        async () => new Response(body, { status: 403 }),
      ),
      (error: unknown) =>
        String(error).includes("HTTP 403") && !String(error).includes(secret),
    );
  for (const stream of [
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0xff]));
        controller.close();
      },
    }),
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(Error(secret));
      },
    }),
  ])
    await assert.rejects(
      d1AdminBatch(
        [statement],
        credentials,
        async () => new Response(stream, { status: 429 }),
      ),
      /HTTP 429; error_body=unreadable$/,
    );
});

test("HTTP error bodies are capped by streamed bytes and cancelled, even with a small declared length", async () => {
  let cancelled = false;
  let calls = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(16 * 1024).fill(120));
      controller.enqueue(new Uint8Array([120]));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    d1AdminBatch([statement], credentials, async () => {
      calls++;
      return new Response(body, {
        status: 403,
        headers: { "content-length": "1" },
      });
    }),
    /HTTP 403; error_body=oversized$/,
  );
  assert.equal(cancelled, true);
  assert.equal(calls, 1);
});

test("provider error text, unknown fields and unsafe or input-echoed request IDs are redacted", async () => {
  const secret = "private-bound-value";
  const sql = "SELECT private_column FROM private_table WHERE key = ?";
  for (const ray of [
    "request-echoes-private-bound-value",
    "0123456789abcdef-LHR",
  ])
    await assert.rejects(
      d1AdminBatch(
        [{ sql, params: [secret, "0123456789abcdef-LHR"] }],
        credentials,
        async () =>
          Response.json(
            {
              errors: [
                {
                  code: credentials.apiToken,
                  message: `${sql}; ${secret}; Bearer ${credentials.apiToken}`,
                  details: { authorization: credentials.apiToken },
                },
                { code: 10000, message: secret },
              ],
              request_id: secret,
            },
            { status: 403, headers: { "cf-ray": ray } },
          ),
      ),
      (error: unknown) => {
        assert.equal(
          String(error),
          "Error: D1 maintenance request failed with HTTP 403; provider_message=Provider message redacted; error_body=json",
        );
        for (const value of [secret, sql, credentials.apiToken, ray])
          assert.equal(String(error).includes(value), false);
        return true;
      },
    );
});

test("a credential shaped like an opaque request ID is still suppressed", async () => {
  const apiToken = "0123456789abcdef";
  await assert.rejects(
    d1AdminBatch([statement], { ...credentials, apiToken }, async () =>
      Response.json(
        { errors: [{ code: 10000, message: "Forbidden" }] },
        { status: 403, headers: { "cf-ray": apiToken } },
      ),
    ),
    (error: unknown) =>
      String(error).includes("HTTP 403") &&
      String(error).includes("provider_code=10000") &&
      !String(error).includes(apiToken),
  );
});

test("empty or unavailable error streams retain the original HTTP classification", async () => {
  for (const response of [
    new Response(null, { status: 403 }),
    new Response("", { status: 403 }),
    new Response(null, { status: 204 }),
  ]) {
    let calls = 0;
    await assert.rejects(
      d1AdminBatch([statement], credentials, async () => {
        calls++;
        return response;
      }),
      new RegExp(`HTTP ${response.status}; error_body=empty$`),
    );
    assert.equal(calls, 1);
  }
  const locked = new Response("private-locked-response", { status: 403 });
  const reader = locked.body!.getReader();
  try {
    await assert.rejects(
      d1AdminBatch([statement], credentials, async () => locked),
      /HTTP 403; error_body=unreadable$/,
    );
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
});

test("cancellation rejection cannot replace an oversized response's HTTP status", async () => {
  let cancellations = 0;
  let calls = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(16 * 1024 + 1).fill(120));
    },
    cancel() {
      cancellations++;
      throw Error("private-cancellation-error");
    },
  });
  await assert.rejects(
    d1AdminBatch([statement], credentials, async () => {
      calls++;
      return new Response(body, { status: 403 });
    }),
    /HTTP 403; error_body=oversized$/,
  );
  assert.equal(cancellations, 1);
  assert.equal(calls, 1);
});

test("provider codes are bounded scalar metadata, limited to one non-input-echoed code", async () => {
  for (const code of [-1, 1.5, 2_147_483_648, "10000", [10000], null])
    await assert.rejects(
      d1AdminBatch([statement], credentials, async () =>
        Response.json({ errors: [{ code }] }, { status: 403 }),
      ),
      (error: unknown) =>
        String(error).includes("HTTP 403") &&
        !String(error).includes("provider_code="),
    );
  await assert.rejects(
    d1AdminBatch(
      [statement],
      credentials,
      async () => new Response('{"errors":[{"code":1e999}]}', { status: 403 }),
    ),
    (error: unknown) =>
      String(error).includes("HTTP 403") &&
      !String(error).includes("provider_code="),
  );
  await assert.rejects(
    d1AdminBatch(
      [{ sql: "SELECT ?", params: ["12345"] }],
      credentials,
      async () => Response.json({ errors: [{ code: 12345 }] }, { status: 403 }),
    ),
    (error: unknown) =>
      String(error).includes("HTTP 403") && !String(error).includes("12345"),
  );
  await assert.rejects(
    d1AdminBatch([statement], credentials, async () =>
      Response.json(
        {
          errors: [
            { code: 10000 },
            ...Array.from({ length: 100 }, () => ({ code: 98765 })),
          ],
        },
        { status: 403 },
      ),
    ),
    (error: unknown) =>
      String(error).includes("HTTP 403") &&
      String(error).includes("provider_code=10000") &&
      (String(error).match(/provider_code=/g) ?? []).length === 1 &&
      !String(error).includes("98765"),
  );
});

test("arbitrary request identifiers and combined header values are never returned", async () => {
  for (const ray of [
    "0123456789abcdef-ABC-extra",
    "0123456789abcdef-abc",
    "https://private.invalid/?token=private-request-value",
    "0123456789abcdef, fedcba9876543210",
    "x".repeat(1024),
  ])
    await assert.rejects(
      d1AdminBatch(
        [statement],
        credentials,
        async () =>
          new Response("{}", { status: 403, headers: { "cf-ray": ray } }),
      ),
      (error: unknown) =>
        String(error).includes("HTTP 403") &&
        !String(error).includes("request_id=") &&
        !String(error).includes(ray),
    );
});
