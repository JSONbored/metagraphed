import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import api from "../workers/api.ts";
import data from "../workers/data-api.ts";
import registry from "../workers/registry-sync-api.ts";
import {
  createNativeApplication,
  type NativeApplicationOptions,
  type NativeInternalService,
} from "../src/native-application.ts";
import type { NativeExecutionContext } from "../src/native-api-process.ts";
import type { NativeOAuthModule } from "../src/native-oauth-provider.ts";
import type { AppKv } from "../src/app-kv.ts";
import type { PgPool } from "../src/pg-pool.ts";
import type { OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import type { NativeOAuthContext } from "../src/native-oauth-provider.ts";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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

function fixture() {
  let pools = 0;
  let ends = 0;
  const order: string[] = [];
  let services!: {
    data: NativeInternalService;
    registry: NativeInternalService;
  };
  const environments = { api: {}, data: {}, registry: {} };
  const pool: PgPool = {
    async query(text) {
      return {
        rows: text.includes("pg_class")
          ? [
              {
                relation: "items",
                owner: "fixture",
                schema_usable: true,
                readable: true,
                insertable: true,
                updatable: true,
                deletable: true,
              },
            ]
          : [],
        rowCount: 0,
      };
    },
    async connect() {
      return { query: pool.query, release() {}, on() {}, removeListener() {} };
    },
    async end() {
      ends += 1;
      order.push("pool");
    },
    on() {},
  };
  const module: NativeOAuthModule = {
    publicFetchProtection: true,
    OAuthProvider: class<Environment> {
      constructor(private options: OAuthProviderOptions<Environment>) {}
      async fetch(
        request: Request,
        env: Environment,
        context: NativeOAuthContext,
      ) {
        if (new URL(request.url).pathname === "/mcp")
          return new Response("oauth");
        const handler = this.options.defaultHandler;
        if (
          handler &&
          typeof handler === "object" &&
          "fetch" in handler &&
          typeof handler.fetch === "function"
        )
          return Reflect.apply(handler.fetch, handler, [request, env, context]);
        throw new Error("Fixture requires an object handler");
      }
    },
    getOAuthApi() {
      throw new Error("unused");
    },
  };
  const options: NativeApplicationOptions = {
    postgres: {
      connectionString: "postgresql://fixture/database",
      maxConnections: 1,
      connectionTimeoutMillis: 100,
      idleTimeoutMillis: 100,
      statementTimeoutMillis: 100,
      onIdleError() {},
    },
    maxRequests: 4,
    maxJobs: 2,
    drainTimeoutMillis: 100,
    sources: [
      {
        name: "auth",
        schema: "auth",
        owner: "fixture",
        relations: ["items"],
        access: "read-write",
      },
    ],
    kv: { control: kv, oauthPending: kv },
    internal: {
      maxConcurrent: 2,
      maxBufferBytes: 64 * 1024,
      maxCalls: 4,
      maxDepth: 2,
      timeoutMillis: 50,
      maxRequestBytes: 1024,
      maxResponseBytes: 1024,
    },
    oauth: { module, source: "auth" },
    onBackgroundError() {},
    async compose(providers) {
      services = providers.services;
      Object.assign(environments.api, {
        DATA_API: services.data,
        REGISTRY_SYNC_API: services.registry,
      });
      return {
        environments,
        assertEnvironment: vi.fn(),
        async stop() {
          order.push("stop");
        },
        async close() {
          order.push("adapters");
        },
      };
    },
  };
  return {
    options,
    environments,
    services: () => services,
    pools: () => pools,
    ends: () => ends,
    order,
    create: () =>
      createNativeApplication(options, () => {
        pools += 1;
        return pool;
      }),
  };
}

afterEach(() => vi.restoreAllMocks());

test("native actor work owns an active internal-service scope and bounded job slot", async () => {
  const f = fixture();
  f.options.maxJobs = 1;
  const app = await f.create();
  const background = deferred();
  let context!: NativeExecutionContext;
  vi.spyOn(data, "fetch").mockImplementation(async (_request, _env, ctx) => {
    assert.equal((ctx as NativeExecutionContext).active, true);
    return new Response("background-data");
  });
  const result = app.background("api", async (ctx) => {
    context = ctx;
    ctx.waitUntil(background.promise);
    return (
      await f.services().data.fetch("https://internal.example/data")
    ).text();
  });
  await Promise.resolve();
  await assert.rejects(
    app.background("api", async () => null),
    /admission/,
  );
  assert.equal(context.active, true);
  background.resolve();
  assert.equal(await result, "background-data");
  assert.equal(context.active, false);
  await assert.rejects(
    f.services().data.fetch("https://internal.example/data"),
    /no active invocation/,
  );
  await assert.rejects(
    app.background("invalid" as never, async () => null),
    /Unknown native background owner/,
  );
  await app.close();
});

test("admitted actor work retains internal services while application shutdown drains", async () => {
  const f = fixture();
  f.options.drainTimeoutMillis = 1000;
  const app = await f.create();
  const entered = deferred(),
    release = deferred();
  vi.spyOn(data, "fetch").mockResolvedValue(new Response("drained-data"));
  const task = app.background("data", async () => {
    entered.resolve();
    await release.promise;
    return (
      await f.services().data.fetch("https://internal.example/data")
    ).text();
  });
  await entered.promise;
  const closing = app.close();
  assert.equal(app.state, "closing");
  await assert.rejects(
    app.background("api", async () => null),
    /admission/,
  );
  assert.equal(f.ends(), 0);
  release.resolve();
  assert.equal(await task, "drained-data");
  await closing;
  assert.deepEqual(f.order, ["stop", "adapters", "pool"]);
});

test("actor background failures and caller cancellation retain process semantics", async () => {
  const f = fixture();
  const app = await f.create();
  const failure = new Error("actor work failed");
  await assert.rejects(
    app.background("registry", async (ctx) => {
      ctx.waitUntil(Promise.reject(failure));
    }),
    (error) => error === failure,
  );
  const controller = new AbortController();
  controller.abort(new Error("caller cancelled"));
  let called = false;
  await assert.rejects(
    app.background(
      "api",
      async () => {
        called = true;
      },
      controller.signal,
    ),
    /caller cancelled/,
  );
  assert.equal(called, false);
  await app.close();
});

test("composition registers partial startup cleanup before returning bindings", async () => {
  const f = fixture();
  const failure = new Error("later adapter construction failed");
  f.options.compose = async (providers) => {
    providers.onStartupCleanup(async () => {
      f.order.push("partial-adapter");
    });
    throw failure;
  };
  await assert.rejects(f.create(), (error) => error === failure);
  assert.deepEqual(f.order, ["partial-adapter", "pool"]);
  assert.equal(f.ends(), 1);
});

describe("native application composition", () => {
  test("routes actual Worker entrypoints with one pool and no listener", async () => {
    const f = fixture();
    f.options.kv = () => ({ control: kv, oauthPending: kv });
    const app = await f.create();
    assert.equal(f.pools(), 1);
    assert.equal(app.state, "ready");
    // The actual registry handler keeps its authenticated write boundary.
    const response = await app.owners.registry.fetch(
      new Request("https://fixture.invalid/sync", { method: "POST" }),
    );
    assert.equal(response.status, 503);
    assert.match(await response.text(), /not provisioned/);
    const unknown = await app.owners.data.fetch(
      new Request("https://fixture.invalid/not-found"),
    );
    assert.equal(unknown.status, 503);
    assert.match(await unknown.text(), /no handler on the data tier/);
    assert.equal(
      await (
        await app.fetch(
          new Request("https://fixture.invalid/mcp", {
            headers: { authorization: "Bearer test" },
          }),
        )
      ).text(),
      "oauth",
    );
    await app.close();
    assert.deepEqual(f.order, ["stop", "adapters", "pool"]);
    assert.equal(f.ends(), 1);
    assert.equal(app.state, "closed");
  });

  test("keeps internal calls in the original invocation and preserves bytes and headers", async () => {
    const f = fixture();
    const observed: NativeExecutionContext[] = [];
    vi.spyOn(api, "fetch").mockImplementation(
      async (_request, env, context) => {
        observed.push(context as NativeExecutionContext);
        const response = await env.DATA_API.fetch(
          new Request("https://fixture.invalid/data", {
            method: "POST",
            body: "payload",
          }),
        );
        assert.equal(response.status, 202);
        assert.equal(response.headers.get("x-test"), "same");
        return new Response(await response.arrayBuffer());
      },
    );
    vi.spyOn(data, "fetch").mockImplementation(
      async (request, _env, context) => {
        observed.push(context as NativeExecutionContext);
        assert.equal(await request.text(), "payload");
        return new Response(new Uint8Array([0, 1, 255]), {
          status: 202,
          headers: { "x-test": "same" },
        });
      },
    );
    const app = await f.create();
    const response = await app.fetch(
      new Request("https://fixture.invalid/test"),
    );
    assert.deepEqual(
      [...new Uint8Array(await response.arrayBuffer())],
      [0, 1, 255],
    );
    assert.equal(observed[0], observed[1]);
    await app.close();
    assert.equal(observed[0].active, false);
    await assert.rejects(
      f.services().data.fetch("https://fixture.invalid/data"),
      /active invocation/,
    );
  });

  test("isolates concurrent request contexts", async () => {
    const f = fixture();
    const contexts = new Map<string, unknown>();
    const gate = deferred();
    vi.spyOn(api, "fetch").mockImplementation(async (request, env, context) => {
      const key = new URL(request.url).pathname;
      contexts.set(key, context);
      if (key === "/one") await gate.promise;
      const response = await env.DATA_API.fetch(request);
      if (key === "/two") gate.resolve();
      return response;
    });
    vi.spyOn(data, "fetch").mockImplementation(
      async (request, _env, context) => {
        const key = new URL(request.url).pathname;
        assert.equal(context, contexts.get(key));
        return new Response(key);
      },
    );
    const app = await f.create();
    const responses = await Promise.all(
      ["one", "two"].map(async (key) =>
        (await app.fetch(new Request(`https://fixture.invalid/${key}`))).text(),
      ),
    );
    assert.deepEqual(responses, ["/one", "/two"]);
    assert.notEqual(contexts.get("/one"), contexts.get("/two"));
    await app.close();
  });

  test("keeps public streaming and background calls active through their full lifetime", async () => {
    const f = fixture();
    let context!: NativeExecutionContext;
    let output!: ReadableStreamDefaultController;
    let backgroundCompleted = false;
    const gate = deferred();
    vi.spyOn(api, "fetch").mockImplementation(async (_request, env, ctx) => {
      context = ctx as NativeExecutionContext;
      ctx.waitUntil!(
        gate.promise.then(async () => {
          assert.equal(context.active, true);
          assert.equal(
            await (
              await env.DATA_API.fetch("https://fixture.invalid/background")
            ).text(),
            "data",
          );
          backgroundCompleted = true;
        }),
      );
      return new Response(
        new ReadableStream({
          start(controller) {
            output = controller;
            controller.enqueue(new TextEncoder().encode("event"));
          },
          cancel() {},
        }),
      );
    });
    vi.spyOn(data, "fetch").mockResolvedValue(new Response("data"));
    const app = await f.create();
    const response = await app.fetch(
      new Request("https://fixture.invalid/stream"),
    );
    assert.equal(context.active, true);
    const closing = app.close();
    const body = response.text();
    output.close();
    assert.equal(context.active, true);
    gate.resolve();
    await closing;
    assert.equal(await body, "event");
    assert.equal(backgroundCompleted, true);
    assert.equal(context.active, false);
  });

  test("routes all cron owners and queue families through shared admission", async () => {
    const f = fixture();
    const seen: string[] = [];
    vi.spyOn(api, "scheduled").mockImplementation(async (event) => {
      seen.push(`api:${event.cron}`);
      return { ok: true };
    });
    vi.spyOn(data, "scheduled").mockImplementation(async (event) => {
      seen.push(`data:${event.cron}`);
      return { ok: true };
    });
    vi.spyOn(registry, "scheduled").mockImplementation(async (event) => {
      seen.push(`registry:${event.cron}`);
      return { ok: true, skipped: true, reason: "fixture" };
    });
    vi.spyOn(api, "queue").mockImplementation(async (batch) => {
      seen.push(`api:${batch.queue}`);
    });
    vi.spyOn(data, "queue").mockImplementation(async (batch) => {
      seen.push(`data:${batch.queue}`);
    });
    const app = await f.create();
    for (const owner of ["api", "data", "registry"] as const)
      await app.owners[owner].scheduled({
        cron: "* * * * *",
        scheduledTime: 1,
      });
    for (const queue of [
      "probe-jobs",
      "webhook-deliveries",
      "sync-batches",
      "probe-jobs-dlq",
      "webhook-deliveries-dlq",
      "sync-batches-dlq",
    ]) {
      await app.owners.api.queue({
        queue,
        messages: [],
        metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
        ackAll() {},
        retryAll() {},
      });
    }
    await assert.rejects(
      app.owners.api.queue({
        queue: "unknown",
        messages: [],
        metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
        ackAll() {},
        retryAll() {},
      }),
      /Unknown native queue/,
    );
    await assert.rejects(
      app.scheduled({
        owner: "unknown" as "api",
        cron: "* * * * *",
        scheduledTime: 1,
      }),
      /Unknown native schedule owner/,
    );
    assert.deepEqual(seen, [
      "api:* * * * *",
      "data:* * * * *",
      "registry:* * * * *",
      "api:probe-jobs",
      "api:webhook-deliveries",
      "data:sync-batches",
      "api:probe-jobs-dlq",
      "api:webhook-deliveries-dlq",
      "data:sync-batches-dlq",
    ]);
    await app.close();
  });

  test("keeps adapters available to an admitted request after shutdown starts", async () => {
    const f = fixture();
    const entered = deferred();
    const proceed = deferred();
    vi.spyOn(api, "fetch").mockImplementation(async (_request, env) => {
      entered.resolve();
      await proceed.promise;
      return env.DATA_API.fetch("https://fixture.invalid/late-internal");
    });
    vi.spyOn(data, "fetch").mockImplementation(async () => {
      assert.deepEqual(f.order, ["stop"]);
      return new Response("drained");
    });
    const app = await f.create();
    const request = app
      .fetch(new Request("https://fixture.invalid/test"))
      .then((response) => response.text());
    await entered.promise;
    const closing = app.close();
    assert.equal(app.state, "closing");
    proceed.resolve();
    assert.equal(await request, "drained");
    await closing;
    assert.deepEqual(f.order, ["stop", "adapters", "pool"]);
  });

  test("rejects detached late calls and aborted internal requests", async () => {
    const f = fixture();
    const late = deferred();
    let detached!: Promise<void>;
    vi.spyOn(api, "fetch").mockImplementation(async (_request, env) => {
      detached = late.promise.then(async () => {
        await assert.rejects(
          env.DATA_API.fetch("https://fixture.invalid/late"),
          /active invocation/,
        );
      });
      const controller = new AbortController();
      controller.abort(new Error("already cancelled"));
      await assert.rejects(
        env.DATA_API.fetch(
          new Request("https://fixture.invalid/aborted", {
            signal: controller.signal,
          }),
        ),
        /already cancelled/,
      );
      await assert.rejects(env.DATA_API.fetch("invalid URL"), /URL/);
      return new Response("done");
    });
    const app = await f.create();
    await (await app.fetch(new Request("https://fixture.invalid/test"))).text();
    await app.close();
    late.resolve();
    await detached;
  });

  test("bounds empty response chunks and yields to deadlines", async () => {
    const f = fixture();
    f.options.internal.timeoutMillis = 2000;
    vi.spyOn(data, "fetch").mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array());
            },
          }),
        ),
    );
    vi.spyOn(api, "fetch").mockImplementation(async (_request, env) => {
      await assert.rejects(
        env.DATA_API.fetch("https://fixture.invalid/chunks"),
        /chunk limit/,
      );
      return new Response("bounded");
    });
    const app = await f.create();
    assert.equal(
      await (
        await app.fetch(new Request("https://fixture.invalid/test"))
      ).text(),
      "bounded",
    );
    await app.close();
  });

  test.each(["created", "reading"])(
    "cancels an internal response body when aborted while %s",
    async (phase) => {
      const f = fixture();
      const responseStarted = deferred();
      let cancelled = false;
      vi.spyOn(data, "fetch").mockImplementation(
        async () =>
          new Response(
            new ReadableStream({
              start() {
                if (phase === "created") responseStarted.resolve();
              },
              pull() {
                responseStarted.resolve();
              },
              cancel() {
                cancelled = true;
                throw new Error("fixture cancellation");
              },
            }),
          ),
      );
      vi.spyOn(api, "fetch").mockImplementation(async (_request, env) => {
        const controller = new AbortController();
        const pending = env.DATA_API.fetch(
          new Request("https://fixture.invalid/body", {
            signal: controller.signal,
          }),
        );
        await responseStarted.promise;
        controller.abort(new Error("body cancelled"));
        await assert.rejects(pending, /body cancelled/);
        return new Response("cancelled");
      });
      const app = await f.create();
      await (
        await app.fetch(new Request("https://fixture.invalid/test"))
      ).text();
      await app.close();
      assert.equal(cancelled, true);
    },
  );

  test.each([
    "D1_STATE",
    "HYPERDRIVE",
    "CHAIN_FIREHOSE_HUB",
    "AI",
    "RPC_USAGE_ANALYTICS",
    "HISTORY_ASSETS",
    "NATIVE_HISTORY_ASSETS_0",
    "ACCOUNT_HISTORY_ASSETS_f",
    "D1_STATE_TABLES",
  ])("rejects legacy selection %s", async (name) => {
    const f = fixture();
    Object.assign(f.environments.api, { [name]: "selected" });
    await assert.rejects(f.create(), /retains|selects D1/);
    assert.equal(f.ends(), 1);
  });

  test("validates the manifest and exact internal service identity", async () => {
    const f = fixture();
    const compose = f.options.compose;
    f.options.compose = async (providers) => {
      const bindings = await compose(providers);
      Object.assign(bindings.environments.api, { DATA_API: { fetch() {} } });
      return bindings;
    };
    await assert.rejects(f.create(), /process-owned bindings/);
    assert.equal(f.ends(), 1);
    const missing = fixture();
    missing.options.oauth.source = "missing";
    await assert.rejects(missing.create(), /OAuth source/);
    assert.equal(missing.ends(), 1);
    const readonly = fixture();
    readonly.options.sources = readonly.options.sources.map((source) => ({
      ...source,
      access: "read",
    }));
    await assert.rejects(readonly.create(), /OAuth source/);
    assert.equal(readonly.ends(), 1);
  });

  test.each([
    "maxConcurrent",
    "maxBufferBytes",
    "maxCalls",
    "maxDepth",
    "timeoutMillis",
    "maxRequestBytes",
    "maxResponseBytes",
  ] as const)("requires explicit finite %s", async (name) => {
    const f = fixture();
    f.options.internal[name] = Infinity;
    await assert.rejects(f.create(), /Invalid native internal/);
    assert.equal(f.pools(), 0);
  });

  test("bounds aggregate buffer ownership before opening a pool", async () => {
    const f = fixture();
    f.options.internal.maxBufferBytes = 1024;
    await assert.rejects(f.create(), /buffer budget/);
    assert.equal(f.pools(), 0);
  });

  test("retains global internal admission until a timed-out handler actually settles", async () => {
    const f = fixture();
    f.options.internal.maxConcurrent = 1;
    f.options.internal.timeoutMillis = 5;
    const pending = deferred<Response>();
    let calls = 0;
    vi.spyOn(data, "fetch").mockImplementation(async () =>
      ++calls === 1 ? pending.promise : new Response("ok"),
    );
    vi.spyOn(api, "fetch").mockImplementation(async (_request, env) => {
      try {
        return await env.DATA_API.fetch("https://fixture.invalid/data");
      } catch (error) {
        return new Response(String(error));
      }
    });
    const app = await f.create();
    const call = () =>
      app
        .fetch(new Request("https://fixture.invalid/test"))
        .then((response) => response.text());
    assert.match(await call(), /deadline/);
    assert.match(await call(), /admission/);
    assert.equal(calls, 1);
    pending.resolve(new Response("late"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(await call(), "ok");
    await app.close();
  });

  test("waits for response cancellation cleanup before releasing pool ownership", async () => {
    const f = fixture();
    f.options.internal.maxResponseBytes = 1;
    const cleanup = deferred();
    const cancelling = deferred();
    vi.spyOn(data, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2]));
          },
          cancel() {
            cancelling.resolve();
            return cleanup.promise;
          },
        }),
      ),
    );
    vi.spyOn(api, "fetch").mockImplementation(async (_request, env) => {
      await assert.rejects(
        env.DATA_API.fetch("https://fixture.invalid/data"),
        /deadline|byte limit/,
      );
      return new Response("bounded");
    });
    const app = await f.create();
    const response = app
      .fetch(new Request("https://fixture.invalid/test"))
      .then((result) => result.text());
    await cancelling.promise;
    const closing = app.close();
    await response;
    assert.equal(f.ends(), 0);
    cleanup.resolve();
    await closing;
    assert.equal(f.ends(), 1);
  });

  test("cleans up bindings when manifest or OAuth validation fails", async () => {
    for (const reason of ["manifest", "oauth"] as const) {
      const f = fixture();
      if (reason === "oauth") f.options.oauth.source = "missing";
      const compose = f.options.compose;
      f.options.compose = async (providers) => {
        const bindings = await compose(providers);
        if (reason === "manifest")
          bindings.assertEnvironment = () => {
            throw new Error("invalid manifest");
          };
        return bindings;
      };
      await assert.rejects(f.create(), /manifest|OAuth source/);
      assert.deepEqual(f.order, ["stop", "adapters", "pool"]);
    }
  });

  test("snapshots native environments, services and OAuth references before admission", async () => {
    const f = fixture();
    let mutateLifecycle!: () => void;
    const compose = f.options.compose;
    f.options.compose = async (providers) => {
      const bindings = await compose(providers);
      bindings.assertEnvironment = (selected) => {
        assert.equal(Object.isFrozen(selected.api), true);
      };
      mutateLifecycle = () => {
        bindings.stop = async () => {
          throw new Error("mutated stop");
        };
        bindings.close = async () => {
          throw new Error("mutated close");
        };
      };
      f.options.oauth.source = "changed during setup";
      f.options.oauth.module.OAuthProvider = class {
        async fetch() {
          return new Response("mutated");
        }
      };
      return bindings;
    };
    vi.spyOn(api, "fetch").mockImplementation(async (_request, env) => {
      assert.equal(Object.isFrozen(env.DATA_API), true);
      assert.equal(env.D1_STATE, undefined);
      return new Response("frozen");
    });
    const app = await f.create();
    mutateLifecycle();
    Object.assign(f.environments.api, { D1_STATE: {} });
    assert.throws(() => {
      f.services().data.fetch = async () => new Response("changed");
    }, TypeError);
    assert.equal(
      await (
        await app.fetch(new Request("https://fixture.invalid/test"))
      ).text(),
      "frozen",
    );
    assert.equal(
      await (
        await app.fetch(new Request("https://fixture.invalid/mcp"))
      ).text(),
      "frozen",
    );
    assert.equal(
      await (
        await app.fetch(
          new Request("https://fixture.invalid/mcp", {
            headers: { authorization: "Bearer fixture" },
          }),
        )
      ).text(),
      "oauth",
    );
    await app.close();
  });

  test("bounds total internal calls and nested depth", async () => {
    const f = fixture();
    f.options.internal.maxCalls = 1;
    vi.spyOn(api, "fetch").mockImplementation(async (_request, env) => {
      await env.DATA_API.fetch("https://fixture.invalid/one");
      await assert.rejects(
        env.REGISTRY_SYNC_API.fetch("https://fixture.invalid/two"),
        /admission/,
      );
      return new Response("done");
    });
    vi.spyOn(data, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    const app = await f.create();
    assert.equal(
      await (
        await app.fetch(new Request("https://fixture.invalid/test"))
      ).text(),
      "done",
    );
    await app.close();
    const nested = fixture();
    nested.options.internal.maxDepth = 1;
    vi.spyOn(api, "fetch").mockImplementation(async (_request, env) =>
      env.DATA_API.fetch("https://fixture.invalid/one"),
    );
    vi.spyOn(data, "fetch").mockImplementation(async () => {
      await assert.rejects(
        nested.services().registry.fetch("https://fixture.invalid/nested"),
        /admission/,
      );
      return new Response("nested");
    });
    const next = await nested.create();
    assert.equal(
      await (
        await next.fetch(new Request("https://fixture.invalid/test"))
      ).text(),
      "nested",
    );
    await next.close();
  });

  test("calls the actual registry handler internally and tolerates absent legacy bindings", async () => {
    const f = fixture();
    Object.assign(f.environments.api, { D1_STATE: undefined });
    vi.spyOn(api, "fetch").mockImplementation(async (_request, env) =>
      env.REGISTRY_SYNC_API.fetch(
        new Request("https://fixture.invalid/sync", { method: "POST" }),
      ),
    );
    const app = await f.create();
    const response = await app.fetch(
      new Request("https://fixture.invalid/test"),
    );
    assert.equal(response.status, 503);
    assert.match(await response.text(), /not provisioned/);
    await app.close();
  });

  test("bounds internal request and response bytes", async () => {
    for (const direction of ["request", "response"] as const) {
      const f = fixture();
      f.options.internal[
        direction === "request" ? "maxRequestBytes" : "maxResponseBytes"
      ] = 1;
      vi.spyOn(api, "fetch").mockImplementation(async (_request, env) => {
        await assert.rejects(
          env.DATA_API.fetch(
            new Request("https://fixture.invalid/data", {
              method: "POST",
              body: direction === "request" ? "too long" : "x",
            }),
          ),
          /byte limit/,
        );
        return new Response("bounded");
      });
      vi.spyOn(data, "fetch").mockResolvedValue(new Response("too long"));
      const app = await f.create();
      assert.equal(
        await (
          await app.fetch(new Request("https://fixture.invalid/test"))
        ).text(),
        "bounded",
      );
      await app.close();
    }
  });

  test("deadline refuses a stalled call while drain retains its unfinished work", async () => {
    const f = fixture();
    f.options.internal.timeoutMillis = 5;
    const pending = deferred<Response>();
    vi.spyOn(data, "fetch").mockImplementation(() => pending.promise);
    vi.spyOn(api, "fetch").mockImplementation(async (_request, env) => {
      await assert.rejects(
        env.DATA_API.fetch("https://fixture.invalid/stalled"),
        /deadline/,
      );
      return new Response("timed out");
    });
    const app = await f.create();
    assert.equal(
      await (
        await app.fetch(new Request("https://fixture.invalid/test"))
      ).text(),
      "timed out",
    );
    let closed = false;
    const closing = app.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(closed, false);
    assert.equal(f.ends(), 0);
    pending.resolve(new Response("late"));
    await closing;
    assert.equal(f.ends(), 1);
  });
});
