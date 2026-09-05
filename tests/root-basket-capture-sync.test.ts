import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, test, vi } from "vitest";
import {
  createProducerStore,
  type ProducerStore,
} from "../src/producer-store.ts";
import {
  handleRootBasketCaptureSync,
  ROOT_BASKET_CAPTURE_MAX_BYTES,
} from "../src/root-basket-capture-sync.ts";
import { syntheticBasketCapture } from "./fixtures/root-basket-capture.ts";
import { dataApiEnv } from "./helpers/worker-env.ts";

const { driver } = vi.hoisted(() => ({
  driver: { query: vi.fn(), close: vi.fn() },
}));
vi.mock("pg", () => ({
  types: { setTypeParser() {} },
  Client: class {
    async connect() {}
    async end() {
      driver.close();
    }
    query(text: string, values: unknown[]) {
      return driver.query(text, values);
    }
  },
}));
const { default: worker } = await import("../workers/data-api.ts");
const { handleRequest } = await import("../workers/api.ts");
const route =
  "https://api.metagraph.sh/api/v1/internal/root-basket-capture-sync";
const secret = "synthetic-receiver-test-token";
const env = { ROOT_BASKET_CAPTURE_SYNC_SECRET: secret };
const request = (
  body: BodyInit | null = JSON.stringify(syntheticBasketCapture()),
  headers: HeadersInit = {},
) =>
  new Request(route, {
    method: "POST",
    body,
    headers: { "x-root-basket-capture-sync-token": secret, ...headers },
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  });
let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  for (const file of [
    "0036_root_basket_observations.sql",
    "0037_root_basket_capture_completion.sql",
  ])
    await db.exec(readFileSync(`migrations/neon/${file}`, "utf8"));
});
beforeEach(async () => {
  await db.exec("TRUNCATE root_basket_captures CASCADE");
  driver.query.mockClear();
  driver.query.mockImplementation(async (text: string, values: unknown[]) => {
    const result = await db.query(text, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? 0 };
  });
  driver.close.mockClear();
});
afterAll(async () => db.close());

test("disabled and unauthorized receivers reject without reading a body or opening storage", async () => {
  const invalidStream = () =>
    new ReadableStream({
      pull(controller) {
        controller.error(new Error("body must not be read"));
      },
    });
  assert.equal(
    (await handleRootBasketCaptureSync(request(invalidStream()), {})).status,
    503,
  );
  for (const token of ["", "incorrect"])
    assert.equal(
      (
        await handleRootBasketCaptureSync(
          request(invalidStream(), {
            "x-root-basket-capture-sync-token": token,
          }),
          env,
        )
      ).status,
      401,
    );
  assert.equal(driver.query.mock.calls.length, 0);
});

test("valid complete input still requires the explicitly configured store", async () => {
  assert.equal((await handleRootBasketCaptureSync(request(), env)).status, 503);
});

test("declared and streamed byte limits reject whole, including a lying length and failed cancellation", async () => {
  for (const length of ["invalid", String(ROOT_BASKET_CAPTURE_MAX_BYTES + 1)])
    assert.equal(
      (
        await handleRootBasketCaptureSync(
          request("{}", { "content-length": length }),
          env,
        )
      ).status,
      413,
    );
  for (const headers of [{}, { "content-length": "2" }] as Record<
    string,
    string
  >[]) {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(ROOT_BASKET_CAPTURE_MAX_BYTES));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        throw new Error("disconnected sender");
      },
    });
    assert.equal(
      (await handleRootBasketCaptureSync(request(stream, headers), env)).status,
      413,
    );
  }
  assert.equal(driver.query.mock.calls.length, 0);
});

test("absent, invalid UTF-8, broken streams, invalid JSON and incomplete observations never write", async () => {
  for (const body of [
    null,
    "not-json",
    "{}",
    new Uint8Array([0xff]),
    new ReadableStream({
      start(controller) {
        controller.error(new Error("disconnected"));
      },
    }),
  ])
    assert.equal(
      (await handleRootBasketCaptureSync(request(body), env)).status,
      400,
    );
  assert.equal(driver.query.mock.calls.length, 0);
});

test("a valid observation exactly at the byte cap can be streamed across chunks", async () => {
  // Legal JSON whitespace exercises the exact transport cap without changing content.
  const text = JSON.stringify(syntheticBasketCapture());
  const encoded = new TextEncoder().encode(
    text + " ".repeat(ROOT_BASKET_CAPTURE_MAX_BYTES - text.length),
  );
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoded.subarray(0, 31));
      controller.enqueue(encoded.subarray(31));
      controller.close();
    },
  });
  const response = await handleRootBasketCaptureSync(
    request(stream, {
      "content-length": String(ROOT_BASKET_CAPTURE_MAX_BYTES),
    }),
    env,
    { store: createProducerStore("postgresql://example/db"), now: () => 3000 },
  );
  assert.equal(response.status, 200);
  assert.equal(driver.close.mock.calls.length, 1);
});

test("too many complete page receipts hit the independent row budget", async () => {
  const capture = syntheticBasketCapture();
  capture.expected_pages = 257;
  capture.expected_funds = 0;
  capture.funds = [];
  const cursor = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
  capture.pages = Array.from({ length: 257 }, (_, i) => ({
    ...capture.pages[0]!,
    page_index: i,
    start_after: i ? cursor(i) : null,
    next_after: i === 256 ? null : cursor(i + 1),
    fund_count: 0,
  }));
  assert.equal(
    (await handleRootBasketCaptureSync(request(JSON.stringify(capture)), env))
      .status,
    413,
  );
  assert.equal(driver.query.mock.calls.length, 0);
});

test("the real protected worker route accepts, replays and rejects a conflict while closing every connection", async () => {
  const workerEnv = dataApiEnv({
    ...env,
    HYPERDRIVE: { connectionString: "postgresql://example/db" },
  });
  const ctx = { waitUntil() {} } as unknown as ExecutionContext;
  const first = await worker.fetch(request(), workerEnv, ctx);
  assert.equal(first.status, 200);
  assert.equal(((await first.json()) as { replayed: boolean }).replayed, false);
  const replay = await worker.fetch(request(), workerEnv, ctx);
  assert.equal(((await replay.json()) as { replayed: boolean }).replayed, true);
  const changed = syntheticBasketCapture();
  changed.metadata_sha256 = `0x${"ff".repeat(32)}`;
  assert.equal(
    (await worker.fetch(request(JSON.stringify(changed)), workerEnv, ctx))
      .status,
    409,
  );
  assert.equal(driver.close.mock.calls.length, 3);
});

test("failed storage is unacknowledged, reported and closed, with and without an error observer", async () => {
  for (const withObserver of [false, true]) {
    const error = withObserver
      ? new Error("database disconnected")
      : "connection unavailable";
    const store = createProducerStore("postgresql://example/db");
    driver.query.mockRejectedValueOnce(error);
    const onError = vi.fn(async () => false);
    const response = await handleRootBasketCaptureSync(request(), env, {
      store,
      ...(withObserver ? { onError } : {}),
    });
    assert.equal(response.status, 503);
    assert.equal(onError.mock.calls.length, withObserver ? 1 : 0);
  }
  assert.equal(driver.close.mock.calls.length, 2);
  const workerEnv = dataApiEnv({
    ...env,
    HYPERDRIVE: { connectionString: "postgresql://example/db" },
  });
  driver.query.mockRejectedValueOnce(new Error("database disconnected"));
  assert.equal(
    (
      await worker.fetch(request(), workerEnv, {
        waitUntil() {},
      } as unknown as ExecutionContext)
    ).status,
    503,
  );
});

test("a missing post-commit receipt is not reported as acknowledged", async () => {
  const underlying = createProducerStore("postgresql://example/db");
  const store: ProducerStore = { ...underlying, first: async () => null };
  assert.equal(
    (await handleRootBasketCaptureSync(request(), env, { store })).status,
    503,
  );
});

test("failed telemetry cannot mask the retry response or prevent connection cleanup", async () => {
  driver.query.mockRejectedValueOnce(new Error("database disconnected"));
  const response = await handleRootBasketCaptureSync(request(), env, {
    store: createProducerStore("postgresql://example/db"),
    onError: async () => {
      throw new Error("telemetry unavailable");
    },
  });
  assert.equal(response.status, 503);
  assert.equal(driver.close.mock.calls.length, 1);
});

test("the edge proxy preserves body/token/status and refuses unbound or non-POST requests", async () => {
  assert.equal((await handleRequest(request(), {} as Env, {})).status, 503);
  const downstream = vi.fn(async (req: Request) => {
    assert.equal(req.headers.get("x-root-basket-capture-sync-token"), secret);
    assert.equal(await req.text(), "capture body");
    return Response.json({ error: "conflicting observation" }, { status: 409 });
  });
  const proxyEnv = { DATA_API: { fetch: downstream } } as unknown as Env;
  assert.equal(
    (await handleRequest(request("capture body"), proxyEnv, {})).status,
    409,
  );
  assert.equal(
    (await handleRequest(new Request(route), proxyEnv, {})).status,
    405,
  );
  assert.equal(downstream.mock.calls.length, 1);
});
