import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { d1AdminBatch, d1AdminCredentials } from "../scripts/lib/d1-admin.ts";
import { d1SchemaVerificationFailure } from "../scripts/lib/d1-migration-ledger.ts";

const credentials = {
  accountId: "a".repeat(32),
  databaseId: "12345678-1234-1234-1234-123456789012",
  apiToken: "test-credential",
};
const statement = { sql: "SELECT ?", params: ["bound"] };
const httpFailure = "D1 maintenance request failed with HTTP 401";
const codeFailure = `${httpFailure}; Cloudflare error codes: 10000`;
const providerFailure = JSON.stringify({
  success: false,
  errors: [{ code: 10000 }],
});
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

test("D1 HTTP diagnostics expose only an allowlisted code, never provider text or request data", async () => {
  const sensitive = JSON.stringify({ credentials, statement });
  let calls = 0;
  await assert.rejects(
    d1AdminBatch([statement], credentials, async () => {
      calls++;
      return Response.json(
        {
          success: false,
          errors: [
            { code: 10000, message: sensitive, source: { pointer: sensitive } },
            { code: 10000, error_chain: [{ code: sensitive }] },
            { code: sensitive },
            { code: 123456789 },
          ],
          messages: [sensitive],
          result: sensitive,
        },
        {
          status: 401,
          statusText: sensitive,
          headers: { "x-request-id": sensitive },
        },
      );
    }),
    (error) =>
      error instanceof Error &&
      error.message === codeFailure &&
      d1SchemaVerificationFailure(error) ===
        "D1 schema verification failed (http_401)" &&
      !Object.hasOwn(error, "cause"),
  );
  assert.equal(calls, 1);
});

test("D1 HTTP diagnostics reject malformed envelopes and unrecognized codes without leaking bodies", async () => {
  for (const body of [
    credentials.apiToken,
    "{",
    "null",
    "[]",
    "{}",
    JSON.stringify({ success: true, errors: [{ code: 10000 }] }),
    JSON.stringify({ success: false, errors: "10000" }),
    JSON.stringify({ success: false, errors: [{ code: "10000" }] }),
    JSON.stringify({ success: false, errors: [{ code: { value: 10000 } }] }),
    JSON.stringify({ success: false, errors: [{ code: 9109 }] }),
    JSON.stringify({ success: false, errors: [null, "10000", 10000] }),
    JSON.stringify({
      success: false,
      errors: [{ message: "10000", error_chain: [{ code: 10000 }] }],
    }),
    JSON.stringify({ success: false, errors: Array(17).fill({ code: 10000 }) }),
    new Uint8Array([0xff]),
  ]) {
    let calls = 0;
    await assert.rejects(
      d1AdminBatch([statement], credentials, async () => {
        calls++;
        return new Response(body, { status: 401 });
      }),
      { message: httpFailure },
    );
    assert.equal(calls, 1);
  }
});

test("D1 HTTP diagnostics accept complete chunked JSON up to the byte limit", async () => {
  const body = JSON.stringify({
    success: false,
    errors: Array(16).fill({ code: 10000, message: "λ" }),
  });
  const encoded = new TextEncoder().encode(body);
  const unicodeSplit = encoded.indexOf(0xce) + 1;
  const padding = new Uint8Array(8 * 1024 - encoded.byteLength).fill(32);
  await assert.rejects(
    d1AdminBatch([statement], credentials, async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoded.subarray(0, unicodeSplit));
            controller.enqueue(encoded.subarray(unicodeSplit));
            controller.enqueue(padding);
            controller.close();
          },
        }),
        { status: 401 },
      ),
    ),
    { message: codeFailure },
  );
});

test("D1 HTTP diagnostics discard an oversized body without awaiting cancellation", async () => {
  let cancellations = 0;
  await assert.rejects(
    d1AdminBatch([statement], credentials, async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(providerFailure));
            controller.enqueue(new Uint8Array(8 * 1024).fill(32));
          },
          cancel() {
            cancellations++;
            return new Promise(() => {});
          },
        }),
        { status: 401 },
      ),
    ),
    { message: httpFailure },
  );
  assert.equal(cancellations, 1);
});

test("D1 HTTP diagnostics suppress body-read and locked-reader errors", async () => {
  const broken = new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new Error(credentials.apiToken));
      },
    }),
    { status: 401 },
  );
  const locked = new Response(providerFailure, { status: 401 });
  const lock = locked.body!.getReader();
  try {
    for (const response of [broken, locked])
      await assert.rejects(
        d1AdminBatch([statement], credentials, async () => response),
        { message: httpFailure },
      );
  } finally {
    lock.releaseLock();
  }
});

test("D1 HTTP diagnostics bound empty chunks and suppress cleanup failures", async () => {
  vi.useFakeTimers();
  try {
    for (const cleanupFails of [false, true, "reject"]) {
      const reader = {
        read: vi.fn(async () => ({ done: false, value: new Uint8Array() })),
        cancel: vi.fn(() => {
          if (cleanupFails === true) throw new Error(credentials.apiToken);
          if (cleanupFails === "reject")
            return Promise.reject(new Error(credentials.databaseId));
          return Promise.resolve();
        }),
        releaseLock: vi.fn(() => {
          if (cleanupFails === true) throw new Error(credentials.accountId);
        }),
      };
      const response = new Response(null, { status: 401 });
      Object.defineProperty(response, "body", {
        value: { getReader: () => reader },
      });
      await assert.rejects(
        d1AdminBatch([statement], credentials, async () => response),
        { message: httpFailure },
      );
      assert.equal(reader.read.mock.calls.length, 64);
      assert.equal(reader.cancel.mock.calls.length, 1);
      assert.equal(reader.releaseLock.mock.calls.length, 1);
    }
  } finally {
    vi.useRealTimers();
  }
});

test("D1 HTTP diagnostics stop at the deadline and never resume a late body read", async () => {
  vi.useFakeTimers();
  try {
    let resolveRead!: (part: ReadableStreamReadResult<Uint8Array>) => void;
    const reader = {
      read: vi.fn(
        () =>
          new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
            resolveRead = resolve;
          }),
      ),
      cancel: vi.fn(() => new Promise(() => {})),
      releaseLock: vi.fn(),
    };
    const response = new Response(null, { status: 401 });
    Object.defineProperty(response, "body", {
      value: { getReader: () => reader },
    });
    const rejected = assert.rejects(
      d1AdminBatch([statement], credentials, async () => response),
      { message: httpFailure },
    );
    await vi.advanceTimersByTimeAsync(500);
    await rejected;
    resolveRead({
      done: false,
      value: new TextEncoder().encode(providerFailure),
    });
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(reader.read.mock.calls.length, 1);
    assert.equal(reader.cancel.mock.calls.length, 1);
    assert.equal(reader.releaseLock.mock.calls.length, 1);
  } finally {
    vi.useRealTimers();
  }
});

test("D1 HTTP diagnostics share one deadline across progressing chunks", async () => {
  vi.useFakeTimers();
  try {
    const bytes = new TextEncoder().encode(providerFailure);
    const parts: ReadableStreamReadResult<Uint8Array>[] = [
      { done: false, value: bytes.subarray(0, 10) },
      { done: false, value: bytes.subarray(10) },
      { done: true, value: undefined },
    ];
    const reader = {
      read: vi.fn(
        () =>
          new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
            setTimeout(() => resolve(parts.shift()!), 200);
          }),
      ),
      cancel: vi.fn(async () => {}),
      releaseLock: vi.fn(),
    };
    const response = new Response(null, { status: 401 });
    Object.defineProperty(response, "body", {
      value: { getReader: () => reader },
    });
    const rejected = assert.rejects(
      d1AdminBatch([statement], credentials, async () => response),
      { message: httpFailure },
    );
    await vi.advanceTimersByTimeAsync(500);
    await rejected;
    await vi.advanceTimersByTimeAsync(200);
    assert.equal(reader.read.mock.calls.length, 3);
    assert.equal(reader.cancel.mock.calls.length, 1);
  } finally {
    vi.useRealTimers();
  }
});
