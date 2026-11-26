import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

/** What the process did, in the order it did it. The entry point's whole job is
 * ordering -- listen before background work, listener closed before the
 * application -- so the cases below read this log rather than call counts. */
const events: string[] = [];
const state = {
  profile: "serving" as "serving" | "producer" | "trusted",
  listenerCloseFails: false,
  listenOptions: undefined as
    | {
        hostname: string;
        port: number;
        origin: string;
        requestTimeoutMillis: number;
      }
    | undefined,
};

vi.mock("../src/native-config.ts", async (original) => ({
  ...(await original<typeof import("../src/native-config.ts")>()),
  // The real reader is proven in native-config.test.ts; here it only has to
  // hand the entry point a profile.
  nativeConfig: async () => ({ profile: state.profile }),
}));

vi.mock("../src/native-environment.ts", () => ({
  createNativeEnvironment: async () => ({
    state: "ready",
    fetch: async () => new Response("fixture"),
    startBackground: () => events.push("background"),
    close: async () => {
      events.push("application-close");
    },
  }),
}));

vi.mock("../src/native-http-server.ts", () => ({
  listenNativeApi: async (
    _application: unknown,
    options: NonNullable<typeof state.listenOptions>,
  ) => {
    events.push("listen");
    state.listenOptions = options;
    return {
      address: { port: options.port },
      close: async () => {
        events.push("listener-close");
        if (state.listenerCloseFails) throw new Error("listener close failed");
      },
    };
  },
}));

const { startNativeProcess } = await import("../src/native-entry.ts");

const ENVIRONMENT = { METAGRAPHED_ORIGIN: "https://api.metagraph.sh" };

beforeEach(() => {
  events.length = 0;
  state.profile = "serving";
  state.listenerCloseFails = false;
  state.listenOptions = undefined;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

test("a serving process listens before it starts background work", async () => {
  const handle = await startNativeProcess(ENVIRONMENT);
  // A process that cannot bind must not have taken a lease it then gives back.
  assert.deepEqual(events, ["listen", "background"]);
  assert.equal(handle.profile, "serving");
  assert.equal(handle.address, "127.0.0.1:8080");
  await handle.stop();
});

test("the listener binds loopback unless the declaration says otherwise", async () => {
  await (await startNativeProcess(ENVIRONMENT)).stop();
  // The tunnel is the ingress and runs beside the task: a wider default bind
  // would be exposure the deployment never asked for.
  assert.equal(state.listenOptions?.hostname, "127.0.0.1");
  assert.equal(state.listenOptions?.origin, "https://api.metagraph.sh");
  // Under Cloudflare Free's 100 s origin read limit, so the origin answers
  // first and the edge never substitutes its own 524.
  assert.ok((state.listenOptions?.requestTimeoutMillis ?? Infinity) < 100_000);

  await (
    await startNativeProcess({
      ...ENVIRONMENT,
      METAGRAPHED_LISTEN_HOSTNAME: "10.0.0.5",
      METAGRAPHED_LISTEN_PORT: "9090",
    })
  ).stop();
  assert.equal(state.listenOptions?.hostname, "10.0.0.5");
  assert.equal(state.listenOptions?.port, 9090);
});

test("a producer process starts no listener at all", async () => {
  state.profile = "producer";
  const handle = await startNativeProcess(ENVIRONMENT);
  // The lane's declaration is "no public listener anywhere": the producer must
  // bind nothing, not merely route nothing.
  assert.deepEqual(events, ["background"]);
  assert.equal(handle.address, undefined);
  await handle.stop();
  assert.deepEqual(events, ["background", "application-close"]);
});

test("the trusted single-process shape listens and runs the loops", async () => {
  state.profile = "trusted";
  const handle = await startNativeProcess(ENVIRONMENT);
  assert.deepEqual(events, ["listen", "background"]);
  await handle.stop();
});

test("a drain closes the listener before the application, once", async () => {
  const handle = await startNativeProcess(ENVIRONMENT);
  events.length = 0;
  // Two signals in one drain (SIGINT then SIGTERM) are one drain.
  const [first, second] = [handle.stop(), handle.stop()];
  assert.equal(first, second);
  await first;
  await handle.stop();
  assert.deepEqual(events, ["listener-close", "application-close"]);
});

test("a listener that fails to close still lets the application drain", async () => {
  state.listenerCloseFails = true;
  const handle = await startNativeProcess(ENVIRONMENT);
  events.length = 0;
  // The application owns the leases; skipping its close because a socket
  // misbehaved would strand them until they expired.
  await handle.stop();
  assert.deepEqual(events, ["listener-close", "application-close"]);
});

test("a serving process without its public origin refuses to start", async () => {
  await assert.rejects(startNativeProcess({}), /METAGRAPHED_ORIGIN/);
  assert.deepEqual(events, [], "nothing was bound or started");
});
