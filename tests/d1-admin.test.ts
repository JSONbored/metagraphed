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
