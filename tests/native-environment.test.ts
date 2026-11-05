import assert from "node:assert/strict";
import { beforeEach, afterEach, test, vi } from "vitest";
import type { NativeApplicationOptions } from "../src/native-application.ts";
import type {
  NativeSource,
  NativeSourceDefinition,
  NativeExecutionContext,
} from "../src/native-api-process.ts";
import type { NativeBackgroundOptions } from "../src/native-background-loops.ts";
import type { NativeSubnetStatusOptions } from "../src/pg-subnet-status-hub.ts";
import type { NativeOAuthModule } from "../src/native-oauth-provider.ts";
import { createNativeEnvironment } from "../src/native-environment.ts";
import { nativeEnvironmentFixture } from "./helpers/native-environment-fixture.ts";

const state = vi.hoisted(() => ({
  applicationState: "ready" as "ready" | "closing" | "closed",
  hooks: [] as (() => Promise<void>)[],
  closed: [] as string[],
  channels: [] as { channel: string }[],
  loops: undefined as NativeBackgroundOptions | undefined,
  status: undefined as NativeSubnetStatusOptions | undefined,
  mutate: "" as "" | "extra" | "value",
  beforeReady: false,
  earlyError: "",
  failClose: "",
  mcpStatus: 200,
  background: vi.fn(),
  scheduled: vi.fn(),
  queued: vi.fn(),
  applicationOptions: undefined as NativeApplicationOptions | undefined,
}));
function close(name: string) {
  return async () => {
    state.closed.push(name);
    if (state.failClose === name) {
      state.failClose = "";
      throw new Error("fixture close rejected");
    }
  };
}
function source(definition: NativeSourceDefinition): NativeSource {
  const query = async <Row>(text: string) =>
    (text.includes("SELECT DISTINCT channel") ? state.channels : []) as Row[];
  const first = async <Row>() => null as Row | null;
  const run = async () => ({ changes: 1 });
  const transaction: NativeSource["transaction"] = async (callback) =>
    callback({ query, first, run });
  const sql: NativeSource["sql"] = Object.assign(async <Row>() => [] as Row[], {
    unsafe: query,
  });
  return {
    ...definition,
    sql,
    read: { query, first },
    producer: { query, first, run, transaction: async () => [] },
    transaction,
  };
}
vi.mock("../src/native-application.ts", () => ({
  createNativeApplication: vi.fn(async (options: NativeApplicationOptions) => {
    state.applicationOptions = options;
    const sources = new Map(
      options.sources.map((definition) => [
        definition.name,
        source(definition),
      ]),
    );
    const kv =
      typeof options.kv === "function"
        ? await options.kv({ sources })
        : options.kv;
    const services = {
      data: { fetch: async () => new Response("data") },
      registry: { fetch: async () => new Response("registry") },
    };
    const bindings = await options.compose({
      sources,
      kv,
      services,
      onStartupCleanup: (cleanup) => state.hooks.push(cleanup),
    });
    const environments = { ...bindings.environments };
    if (state.mutate === "extra")
      environments.api = { ...environments.api, unexpected: true };
    if (state.mutate === "value")
      environments.api = { ...environments.api, ASSETS: {} };
    bindings.assertEnvironment(environments);
    const owner = () => ({
      fetch: async () => new Response("owner"),
      scheduled: state.scheduled,
      queue: state.queued,
    });
    return {
      get state() {
        return state.applicationState;
      },
      fetch: async () => new Response("main"),
      owners: { api: owner(), data: owner(), registry: owner() },
      background: async <Result>(
        name: string,
        callback: (context: NativeExecutionContext) => Promise<Result>,
      ) => {
        state.background(name);
        return callback({
          active: true,
          signal: new AbortController().signal,
          waitUntil() {},
        });
      },
      close: async () => {
        state.applicationState = "closing";
        await bindings.stop();
        await bindings.close();
        state.applicationState = "closed";
      },
    };
  }),
}));
vi.mock("../src/sqlite-document-decoder.ts", () => ({
  createSqliteDocumentDecoder: () => ({ close: close("decoder") }),
}));
vi.mock("../src/pg-state-export.ts", () => ({
  createPgStateExport: () => ({ export: async () => new Response("export") }),
}));
vi.mock("../src/native-static-assets.ts", () => ({
  createNativeStaticAssets: async () => ({
    fetch: async () => new Response("asset"),
    close: close("assets"),
  }),
}));
vi.mock("../src/archive-content-fs.ts", () => ({
  createFilesystemArchiveContent: async () => ({
    get: async () => new Response("archive"),
  }),
}));
vi.mock("../src/native-ai-inference.ts", () => ({
  createNativeAiInference: () => ({ close: close("inference") }),
}));
vi.mock("../src/semantic-index-pg.ts", () => ({
  createPgSemanticIndex: async () => ({ query: async () => ({ matches: [] }) }),
}));
vi.mock("../src/pg-subnet-status-hub.ts", () => ({
  createPgSubnetStatusHub: async (
    _runtime: unknown,
    options: NativeSubnetStatusOptions,
  ) => {
    state.status = options;
    if (state.beforeReady) {
      try {
        await options.notify("early", "uri", new AbortController().signal);
      } catch (error) {
        state.earlyError = String(error);
      }
    }
    return {
      fetch: async () => new Response("status"),
      close: close("status"),
    };
  },
}));
vi.mock("../src/native-alerter.ts", () => ({
  createNativeAlerter: async () => ({
    fetch: async () => new Response("alerter"),
    close: close("alerter"),
  }),
}));
vi.mock("../src/native-chain-firehose.ts", () => ({
  createNativeChainFirehose: async () => ({
    fetch: async () => new Response("chain"),
    runDueAlarm: async () => 1,
    close: close("chain"),
  }),
}));
vi.mock("../src/native-mcp-sessions.ts", () => ({
  createNativeMcpSessions: async () => ({
    fetch: async () => new Response(null, { status: state.mcpStatus }),
    runDueAlarms: async () => 2,
    close: close("mcp"),
  }),
}));
vi.mock("../src/pg-queue.ts", () => ({
  createPgQueueTransport: async () => ({
    binding: (name: string) => ({ name, send: async () => {} }),
    run: async () => {},
    close: close("queues"),
  }),
}));
vi.mock("../src/pg-cron.ts", () => ({
  createPgCronScheduler: async () => ({
    register: async () => {},
    plan: async () => {},
    run: async () => {},
    close: close("cron"),
  }),
}));
vi.mock("../src/native-background-loops.ts", () => ({
  createNativeBackgroundLoops: (options: NativeBackgroundOptions) => {
    state.loops = options;
    if (state.beforeReady)
      assert.throws(
        () =>
          options.owners.api.scheduled({ cron: "fixture", scheduledTime: 0 }),
        /not bound/,
      );
    return { start: async () => {}, stop: close("loops") };
  },
}));

const oauth: NativeOAuthModule = {
  publicFetchProtection: true,
  OAuthProvider: class {
    async fetch() {
      return new Response("fixture");
    }
  },
  getOAuthApi() {
    throw new Error("unused OAuth fixture");
  },
};
const options = () =>
  nativeEnvironmentFixture(
    "postgresql://fixture-only",
    "fixture_owner",
    { assets: "fixture", archive: "fixture" },
    oauth,
  );
beforeEach(() => {
  state.applicationState = "ready";
  state.hooks = [];
  state.closed = [];
  state.channels = [];
  state.loops = undefined;
  state.status = undefined;
  state.mutate = "";
  state.beforeReady = false;
  state.earlyError = "";
  state.failClose = "";
  state.mcpStatus = 200;
  state.background.mockReset();
  state.scheduled.mockReset();
  state.queued.mockReset();
});
afterEach(async () => {
  state.failClose = "";
  for (const cleanup of state.hooks.reverse()) await cleanup();
  vi.restoreAllMocks();
});

test("constructs a fixed complete environment and keeps internal owners guarded until ready", async () => {
  state.beforeReady = true;
  const application = await createNativeEnvironment(options());
  assert.match(state.earlyError, /MCP actor is not bound/);
  assert.equal(
    await (
      await application.fetch(new Request("https://fixture.example"))
    ).text(),
    "main",
  );
  await state.loops!.owners.api.scheduled({
    cron: "fixture",
    scheduledTime: 0,
  });
  await state.loops!.owners.data.scheduled({
    cron: "fixture",
    scheduledTime: 0,
  });
  await state.loops!.owners.registry.scheduled({
    cron: "fixture",
    scheduledTime: 0,
  });
  await state.loops!.owners.api.queue({} as MessageBatch<unknown>);
  await state.loops!.owners.data.queue({} as MessageBatch<unknown>);
  assert.equal(state.scheduled.mock.calls.length, 3);
  assert.equal(state.queued.mock.calls.length, 2);
  await state.loops!.mcp.runDueAlarms(3);
  await state.loops!.chain.runDueAlarm();
  assert.deepEqual(state.background.mock.calls, [["api"], ["api"]]);
  await state.status!.notify("session", "uri", new AbortController().signal);
  state.mcpStatus = 500;
  await assert.rejects(
    state.status!.notify("session", "uri", new AbortController().signal),
    /notification was rejected/,
  );
  state.loops!.onError(new Error("fixture"), "fixture-loop");
  await application.startBackground(0);
  await application.close();
  assert.equal(application.state, "closed");
  assert.deepEqual(state.closed.slice(0, 8), [
    "loops",
    "loops",
    "cron",
    "queues",
    "mcp",
    "chain",
    "alerter",
    "status",
  ]);
  await application.close();
  assert.equal(state.closed.filter((name) => name === "decoder").length, 1);
  await assert.rejects(application.startBackground(0), /not ready/);
});

test("refuses mismatched identities, altered environments and missing delivery credentials", async () => {
  const tooSmall = options();
  tooSmall.postgres.maxConnections = 4;
  await assert.rejects(createNativeEnvironment(tooSmall), /at least five/);
  const mismatch = options();
  mismatch.semanticIndex.dimensions = 3;
  await assert.rejects(createNativeEnvironment(mismatch), /identities differ/);
  for (const change of ["extra", "value"] as const) {
    state.mutate = change;
    await assert.rejects(
      createNativeEnvironment(options()),
      /differs from its constructed/,
    );
  }
  state.mutate = "";
  state.channels = [{ channel: "telegram" }];
  await assert.rejects(
    createNativeEnvironment(options()),
    /TELEGRAM_BOT_TOKEN/,
  );
  state.channels = [{ channel: "unsupported" }];
  await assert.rejects(
    createNativeEnvironment(options()),
    /channel is unsupported/,
  );
  state.channels = [{ channel: "webhook" }, { channel: "discord" }];
  const application = await createNativeEnvironment(options());
  await application.close();
});

test("accepts configured stored delivery channels and refuses empty credentials", async () => {
  state.channels = [
    { channel: "telegram" },
    { channel: "email" },
    { channel: "webpush" },
  ];
  const configured = options();
  const settings = configured.settings as { api: Record<string, string> };
  for (const name of [
    "TELEGRAM_BOT_TOKEN",
    "RESEND_API_KEY",
    "RESEND_FROM_ADDRESS",
    "VAPID_PUBLIC_KEY",
    "VAPID_PRIVATE_KEY",
    "VAPID_SUBJECT",
  ])
    settings.api[name] = "fixture-delivery-value";
  const application = await createNativeEnvironment(configured);
  await application.close();
  settings.api.TELEGRAM_BOT_TOKEN = " ";
  await assert.rejects(
    createNativeEnvironment(configured),
    /TELEGRAM_BOT_TOKEN/,
  );
});

test("retains failed cleanup for retry rather than closing remaining adapters", async () => {
  const application = await createNativeEnvironment(options());
  state.failClose = "queues";
  await assert.rejects(application.close(), /fixture close rejected/);
  assert(!state.closed.includes("decoder"));
  await application.close();
  assert.equal(application.state, "closed");
  assert.equal(state.closed.filter((name) => name === "queues").length, 2);
  assert(state.closed.includes("decoder"));
});
