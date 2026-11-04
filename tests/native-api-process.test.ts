import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import { queueDelivery } from "../src/queue-delivery.ts";
import type { AppKv } from "../src/app-kv.ts";
import type { PgPool, PooledPgOptions } from "../src/pg-pool.ts";
import {
  createNativeApiProcess,
  NativeScheduledBackgroundError,
  type NativeApiOptions,
  type NativeExecutionContext,
  type NativeSource,
} from "../src/native-api-process.ts";

const postgres: PooledPgOptions = {
  connectionString: "postgresql://fixture/database",
  maxConnections: 2,
  connectionTimeoutMillis: 1000,
  idleTimeoutMillis: 1000,
  statementTimeoutMillis: 1000,
  onIdleError() {},
};
const kv: AppKv = {
  async get() {
    return null;
  },
  async put() {},
  async delete() {},
  async list() {
    return { keys: [], list_complete: true };
  },
  async consume() {
    return null;
  },
};
const source = {
  name: "application",
  schema: "app",
  owner: "fixture_owner",
  relations: ["items"],
  access: "read-write" as const,
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  let factories = 0;
  let ends = 0;
  const calls: { text: string; values?: unknown[] }[] = [];
  let relationRows: unknown[] = [
    {
      relation: "items",
      owner: "fixture_owner",
      schema_usable: true,
      readable: true,
      insertable: true,
      updatable: true,
      deletable: true,
    },
  ];
  const pool: PgPool = {
    async query(text, values) {
      calls.push({ text, values });
      return {
        rows: text.includes("pg_class")
          ? relationRows
          : [{ value: "9007199254740993" }],
        rowCount: 1,
      };
    },
    async connect() {
      return { query: pool.query, release() {}, on() {}, removeListener() {} };
    },
    async end() {
      ends += 1;
    },
    on() {},
  };
  const errors: unknown[] = [];
  type Environment = { database: NativeSource };
  let currentContext: NativeExecutionContext | undefined;
  let response = () => new Response("main");
  const seen: string[] = [];
  const options: NativeApiOptions<Environment, string, string> = {
    postgres,
    maxRequests: 1,
    maxJobs: 1,
    drainTimeoutMillis: 1000,
    sources: [source],
    kv: { control: kv, oauthPending: kv },
    onBackgroundError: (error) => {
      errors.push(error);
    },
    async compose({ sources }) {
      return {
        environment: { database: sources.get("application")! },
        application: {
          async fetch(request, env, ctx) {
            currentContext = ctx;
            seen.push("main:" + new URL(request.url).pathname);
            await env.database.read.query("SELECT value FROM items");
            return response();
          },
          async scheduled(event, _env, ctx) {
            currentContext = ctx;
            seen.push("scheduled:" + event);
          },
          async queue(batch, _env, ctx) {
            currentContext = ctx;
            seen.push("queue:" + batch);
          },
        },
        authorization: {
          provider: {
            async fetch(request) {
              seen.push("auth:" + new URL(request.url).pathname);
              return new Response("auth");
            },
          },
        },
        async directory(request) {
          return new URL(request.url).pathname === "/directory"
            ? new Response("directory")
            : null;
        },
      };
    },
  };
  const create = () =>
    createNativeApiProcess(options, () => {
      factories += 1;
      return pool;
    });
  return {
    options,
    create,
    pool,
    calls,
    seen,
    errors,
    setRelationRows(rows: unknown[]) {
      relationRows = rows;
    },
    setResponse(value: () => Response) {
      response = value;
    },
    context: () => currentContext!,
    factories: () => factories,
    ends: () => ends,
  };
}

describe("native API process", () => {
  test("uses one checked source runtime through shared entry routing", async () => {
    const f = fixture();
    const process = await f.create();
    assert.equal(process.state, "ready");
    assert.equal(f.factories(), 1);
    assert.deepEqual(f.calls[0].values, ["app", ["items"]]);
    for (const [path, authorization, expected] of [
      ["/directory", null, "directory"],
      ["/mcp", null, "main"],
      ["/mcp", "Bearer mg_fixture", "main"],
      ["/mcp", "Bearer oauth_fixture", "auth"],
      ["/authorize", null, "auth"],
    ]) {
      const headers: HeadersInit = authorization ? { authorization } : {};
      assert.equal(
        await (
          await process.fetch(
            new Request(`https://fixture.invalid${path}`, { headers }),
          )
        ).text(),
        expected,
      );
    }
    await process.scheduled("tick");
    await process.queue("batch");
    assert.deepEqual(f.seen, [
      "main:/mcp",
      "main:/mcp",
      "auth:/mcp",
      "auth:/authorize",
      "scheduled:tick",
      "queue:batch",
    ]);
    assert.equal(
      f.calls.filter((call) => call.text === "SELECT value FROM items").length,
      2,
    );
    assert.deepEqual(
      f.calls.slice(1, 5).map((call) => call.text),
      [
        "BEGIN ISOLATION LEVEL READ COMMITTED",
        "SELECT pg_catalog.set_config('search_path', $1, true)",
        "SELECT value FROM items",
        "COMMIT",
      ],
    );
    assert.deepEqual(f.calls[2].values, ['pg_catalog, "app", pg_temp']);
    await process.close();
    assert.equal(f.ends(), 1);
    assert.equal(process.state, "closed");
  });

  test("rejects missing KV and OAuth adapters before serving", async () => {
    const f = fixture();
    f.options.kv.control = { ...kv, consume: undefined };
    await assert.rejects(f.create(), /control KV.consume/);
    assert.equal(f.factories(), 0);
    f.options.kv.control = kv;
    const compose = f.options.compose;
    f.options.compose = async (providers) => {
      const composition = await compose(providers);
      return {
        ...composition,
        authorization: undefined,
      } as unknown as typeof composition;
    };
    await assert.rejects(f.create(), /OAuth provider.fetch/);
    assert.equal(f.ends(), 1);
  });

  test("refuses absent, differently owned and unreadable source relations", async () => {
    for (const rows of [
      [],
      [{ relation: "items", owner: "other", readable: true }],
      [
        {
          relation: "items",
          owner: "fixture_owner",
          schema_usable: true,
          readable: false,
        },
      ],
      [
        {
          relation: "items",
          owner: "fixture_owner",
          schema_usable: false,
          readable: true,
        },
      ],
    ]) {
      const f = fixture();
      f.setRelationRows(rows);
      await assert.rejects(f.create(), /source application is not ready/);
      assert.equal(f.ends(), 1);
    }
  });

  test("refuses incomplete write privileges and overlapping declarations", async () => {
    const f = fixture();
    f.setRelationRows([
      {
        relation: "items",
        owner: "fixture_owner",
        schema_usable: true,
        readable: true,
        insertable: true,
        updatable: false,
        deletable: true,
      },
    ]);
    await assert.rejects(f.create(), /source application is not ready/);
    f.options.sources = [source, { ...source, name: "duplicate" }];
    f.setRelationRows([
      {
        relation: "items",
        owner: "fixture_owner",
        schema_usable: true,
        readable: true,
        insertable: true,
        updatable: true,
        deletable: true,
      },
    ]);
    await assert.rejects(f.create(), /ownership overlaps/);
  });

  test("keeps source SQL and writes on the same schema-scoped transaction", async () => {
    const f = fixture();
    const compose = f.options.compose;
    f.options.compose = async (providers) => {
      const application = providers.sources.get("application")!;
      assert.equal("close" in application, false);
      await application.sql`SELECT ${7} FROM items`;
      await application.producer.run("UPDATE items SET value = ?", [8]);
      await application.producer.transaction([
        { text: "UPDATE items SET value = ?", values: [9] },
        { text: "DELETE FROM items WHERE value = ?", values: [10] },
      ]);
      return compose(providers);
    };
    const process = await f.create();
    assert.deepEqual(
      f.calls.slice(1).map((call) => call.text),
      [
        "BEGIN ISOLATION LEVEL READ COMMITTED",
        "SELECT pg_catalog.set_config('search_path', $1, true)",
        "SELECT $1 FROM items",
        "COMMIT",
        "BEGIN ISOLATION LEVEL READ COMMITTED",
        "SELECT pg_catalog.set_config('search_path', $1, true)",
        "UPDATE items SET value = $1",
        "COMMIT",
        "BEGIN ISOLATION LEVEL READ COMMITTED",
        "SELECT pg_catalog.set_config('search_path', $1, true)",
        "UPDATE items SET value = $1",
        "DELETE FROM items WHERE value = $1",
        "COMMIT",
      ],
    );
    await process.close();
  });

  test("enforces a read-only source across every transaction path", async () => {
    const f = fixture();
    f.options.sources = [{ ...source, access: "read" }];
    const compose = f.options.compose;
    f.options.compose = async (providers) => {
      const database = providers.sources.get("application")!;
      await database.read.query("SELECT value FROM items");
      await database.read.first("SELECT value FROM items");
      await database.sql.unsafe("SELECT value FROM items");
      await assert.rejects(
        database.producer.run("DELETE FROM items"),
        /read-only/,
      );
      await assert.rejects(
        database.producer.transaction([{ text: "DELETE FROM items" }]),
        /read-only/,
      );
      await assert.rejects(
        database.transaction((scope) => scope.run("DELETE FROM items")),
        /read-only/,
      );
      return compose(providers);
    };
    const process = await f.create();
    assert.equal(
      f.calls.filter((call) => call.text === "SET TRANSACTION READ ONLY")
        .length,
      4,
    );
    assert.equal(
      f.calls.some((call) => call.text === "DELETE FROM items"),
      false,
    );
    await process.close();
  });

  test("rejects incomplete source definitions and invalid process bounds", async () => {
    for (const override of [
      { maxRequests: 0 },
      { maxJobs: 0 },
      { drainTimeoutMillis: 0 },
    ]) {
      const f = fixture();
      Object.assign(f.options, override);
      await assert.rejects(f.create(), /positive safe integers/);
      assert.equal(f.factories(), 0);
    }
    for (const sources of [
      [],
      [{ ...source, name: "" }],
      [{ ...source, relations: [] }],
      [source, source],
    ]) {
      const f = fixture();
      f.options.sources = sources;
      await assert.rejects(f.create(), /ownership is required|unique names/);
      assert.equal(f.ends(), 1);
    }
  });

  test("holds request admission and shutdown through the streamed body and background work", async () => {
    const f = fixture();
    const background = deferred();
    let body!: ReadableStreamDefaultController<Uint8Array>;
    f.setResponse(() => {
      f.context().waitUntil(background.promise);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            body = controller;
          },
        }),
        { status: 206, headers: { "x-fixture": "kept" } },
      );
    });
    const process = await f.create();
    const response = await process.fetch(
      new Request("https://fixture.invalid/mcp"),
    );
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("x-fixture"), "kept");
    assert.equal(
      (await process.fetch(new Request("https://fixture.invalid/mcp"))).status,
      503,
    );
    const closing = process.close();
    assert.equal(process.state, "closing");
    assert.equal(f.ends(), 0);
    const text = response.text();
    body.enqueue(new TextEncoder().encode("streamed"));
    body.close();
    assert.equal(await text, "streamed");
    assert.equal(f.ends(), 0);
    background.resolve();
    await closing;
    assert.equal(f.ends(), 1);
    assert.equal(process.close(), closing);
  });

  test("drains queued background work and refuses concurrent/new jobs", async () => {
    const f = fixture();
    const background = deferred();
    const compose = f.options.compose;
    f.options.compose = async (providers) => {
      const composition = await compose(providers);
      composition.application.queue = async (_batch, _env, ctx) => {
        ctx.waitUntil(background.promise);
      };
      return composition;
    };
    const process = await f.create();
    const job = process.queue("first");
    await assert.rejects(
      process.scheduled("overlap"),
      /admission is unavailable/,
    );
    const closing = process.close();
    await assert.rejects(process.queue("closed"), /admission is unavailable/);
    assert.equal(f.ends(), 0);
    background.resolve();
    await Promise.all([job, closing]);
    assert.equal(f.ends(), 1);
  });

  test("queue background rejection reaches transport defaults while explicit acknowledgments survive", async () => {
    const f = fixture();
    const compose = f.options.compose;
    const failure = new Error("queue background failed");
    const delivery = queueDelivery(
      "probe-jobs",
      ["a", "b"].map((id) => ({
        id,
        createdAtMs: 1,
        attempts: 1,
        body: { id },
      })),
      { backlogCount: 2, backlogBytes: 0 },
    );
    f.options.compose = async (providers) => {
      const composition = await compose(providers);
      composition.application.queue = async (_batch, _env, ctx) => {
        delivery.batch.messages[0]!.ack();
        ctx.waitUntil(Promise.reject(failure));
      };
      composition.application.scheduled = async (_event, _env, ctx) => {
        ctx.waitUntil(Promise.reject(failure));
        return { ok: false, skipped: true };
      };
      return composition;
    };
    const process = await f.create();
    await assert.rejects(process.queue("first"), (error) => error === failure);
    assert.deepEqual(delivery.finish(true), [
      { action: "ack" },
      { action: "retry" },
    ]);
    await assert.rejects(process.scheduled("record result"), (error) => {
      assert.ok(error instanceof NativeScheduledBackgroundError);
      assert.equal(error.cause, failure);
      assert.deepEqual(error.result, { ok: false, skipped: true });
      return true;
    });
    assert.equal(f.errors.length, 2);
    await process.close();
    assert.equal(f.ends(), 1);
  });

  test("a queue handler error remains primary after background work fails", async () => {
    const f = fixture();
    const compose = f.options.compose;
    const primary = new Error("handler failed");
    f.options.compose = async (providers) => {
      const composition = await compose(providers);
      composition.application.queue = async (_batch, _env, ctx) => {
        ctx.waitUntil(Promise.reject(new Error("background failed")));
        throw primary;
      };
      return composition;
    };
    const process = await f.create();
    await assert.rejects(process.queue("first"), (error) => error === primary);
    assert.equal(f.errors.length, 1);
    await process.close();
  });

  test.each(["queue", "scheduled"] as const)(
    "%s cancellation reaches the invocation signal and refuses an already-aborted dispatch",
    async (kind) => {
      const f = fixture();
      const compose = f.options.compose;
      const entered = deferred();
      const reason = new Error("consumer deadline");
      let calls = 0;
      f.options.compose = async (providers) => {
        const composition = await compose(providers);
        composition.application[kind] = async (_batch, _env, ctx) => {
          calls += 1;
          entered.resolve();
          await new Promise<void>((resolve) =>
            ctx.signal.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          );
        };
        return composition;
      };
      const process = await f.create();
      const abort = new AbortController();
      const running = process[kind]("active", abort.signal);
      await entered.promise;
      abort.abort(reason);
      await assert.rejects(running, (error) => error === reason);
      await assert.rejects(
        process[kind]("never dispatched", abort.signal),
        (error) => error === reason,
      );
      assert.equal(calls, 1);
      await process.close();
    },
  );

  test("cancels response bodies and reports rejected background work", async () => {
    const f = fixture();
    let cancelled: unknown;
    f.setResponse(() => {
      f.context().waitUntil(Promise.reject(new Error("background failed")));
      return new Response(
        new ReadableStream({
          cancel(reason) {
            cancelled = reason;
          },
        }),
      );
    });
    const process = await f.create();
    const response = await process.fetch(
      new Request("https://fixture.invalid/mcp"),
    );
    await response.body!.cancel("disconnect");
    assert.equal(cancelled, "disconnect");
    assert.equal((f.errors[0] as Error).message, "background failed");
    await process.close();
  });

  test("times out shutdown, cancels owned streams and retains unfinished work", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const f = fixture();
      f.options.drainTimeoutMillis = 10;
      const pending = deferred();
      let cancelled = false;
      f.setResponse(() => {
        f.context().waitUntil(pending.promise);
        return new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        );
      });
      const process = await f.create();
      const response = await process.fetch(
        new Request("https://fixture.invalid/mcp"),
      );
      const body = response.text().catch((error) => error as Error);
      const closing = assert.rejects(
        process.close(),
        /drain deadline exceeded/,
      );
      await vi.advanceTimersByTimeAsync(10);
      await closing;
      assert.equal(f.context().signal.aborted, true);
      assert.equal(cancelled, true);
      assert.equal(process.state, "closing");
      assert.equal(f.ends(), 0);
      assert.match(((await body) as Error).message, /drain deadline exceeded/);
      pending.resolve();
      await process.close();
      assert.equal(f.ends(), 1);
      assert.equal(process.state, "closed");
    } finally {
      vi.useRealTimers();
    }
  });

  test("signals stalled jobs without closing their database prematurely", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const f = fixture();
      f.options.drainTimeoutMillis = 10;
      const pending = deferred();
      let signal!: AbortSignal;
      const compose = f.options.compose;
      f.options.compose = async (providers) => {
        const composition = await compose(providers);
        composition.application.queue = async (_batch, _env, ctx) => {
          signal = ctx.signal;
          await pending.promise;
        };
        return composition;
      };
      const process = await f.create();
      const job = process.queue("stalled");
      const closing = assert.rejects(
        process.close(),
        /drain deadline exceeded/,
      );
      await vi.advanceTimersByTimeAsync(10);
      await closing;
      assert.equal(signal.aborted, true);
      assert.equal(process.state, "closing");
      assert.equal(f.ends(), 0);
      pending.resolve();
      await job;
      await process.close();
      assert.equal(process.state, "closed");
    } finally {
      vi.useRealTimers();
    }
  });

  test("finishes bodyless responses and contains failed error reporters", async () => {
    const f = fixture();
    f.options.onBackgroundError = () => {
      throw new Error("reporter failed");
    };
    f.setResponse(() => {
      f.context().waitUntil(Promise.reject(new Error("background failed")));
      return new Response(null, { status: 204 });
    });
    const process = await f.create();
    assert.equal(
      (await process.fetch(new Request("https://fixture.invalid/mcp"))).status,
      204,
    );
    await process.close();
    assert.equal(f.ends(), 1);
    assert.equal(
      (await process.fetch(new Request("https://fixture.invalid/mcp"))).status,
      503,
    );
  });

  test("propagates a request aborted before its response stream is created", async () => {
    const f = fixture();
    let cancelled = false;
    f.setResponse(
      () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        ),
    );
    const controller = new AbortController();
    controller.abort(new Error("request aborted"));
    const process = await f.create();
    const response = await process.fetch(
      new Request("https://fixture.invalid/mcp", { signal: controller.signal }),
    );
    await assert.rejects(response.text(), /request aborted/);
    assert.equal(cancelled, true);
    await process.close();
  });

  test("signals background work after its response body has completed", async () => {
    const f = fixture();
    const pending = deferred();
    f.setResponse(() => {
      f.context().waitUntil(pending.promise);
      return new Response("complete");
    });
    const controller = new AbortController();
    const process = await f.create();
    const response = await process.fetch(
      new Request("https://fixture.invalid/mcp", { signal: controller.signal }),
    );
    assert.equal(await response.text(), "complete");
    controller.abort(new Error("disconnected"));
    assert.equal(f.context().signal.aborted, true);
    pending.resolve();
    await process.close();
  });

  test("releases failed requests and rejects escaped background registrations", async () => {
    const f = fixture();
    f.setResponse(() => {
      throw new Error("handler failed");
    });
    const process = await f.create();
    await assert.rejects(
      process.fetch(new Request("https://fixture.invalid/mcp")),
      /handler failed/,
    );
    assert.throws(
      () => f.context().waitUntil(Promise.resolve()),
      /invocation has finished/,
    );
    await process.close();
    assert.equal(f.ends(), 1);
  });
});
