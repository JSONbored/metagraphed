import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Socket } from "node:net";
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  providers: [] as { endpoint: string; disconnect: ReturnType<typeof vi.fn> }[],
}));
vi.mock("@polkadot/api", () => ({
  WsProvider: class {
    endpoint: string;
    disconnect = vi.fn(async () => {});
    constructor(endpoint: string) {
      this.endpoint = endpoint;
      mocks.providers.push(this);
    }
  },
  ApiPromise: { create: mocks.create },
}));
beforeEach(() => {
  // Trap even an accidentally unmocked SDK provider before any real socket
  // opens. This suite qualifies fixtures exclusively.
  vi.spyOn(Socket.prototype, "connect").mockImplementation(() => {
    throw new Error("Network access is forbidden in wallet fixtures");
  });
  vi.resetModules();
  mocks.create.mockReset();
  mocks.providers.length = 0;
  vi.stubGlobal("window", {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
test("wallet connections stay partitioned by the requested network and share concurrent setup", async () => {
  const { getApi, rpcEndpointForNetwork } = await import("./chain-connection");
  mocks.create.mockImplementation(async ({ provider }) => ({ endpoint: provider.endpoint }));
  const main = rpcEndpointForNetwork("mainnet"),
    testnet = rpcEndpointForNetwork("testnet");
  const [a, b, c] = await Promise.all([getApi(main), getApi(testnet), getApi(main)]);
  expect(a).toBe(c);
  expect(a).not.toBe(b);
  expect(a).toEqual({ endpoint: "wss://entrypoint-finney.opentensor.ai" });
  expect(b).toEqual({ endpoint: "wss://test.finney.opentensor.ai" });
  expect(mocks.create).toHaveBeenCalledTimes(2);
  expect(() => rpcEndpointForNetwork("local")).toThrow(/network/);
});
test("failed connection attempts disconnect their provider and permit a clean retry", async () => {
  const { getApi } = await import("./chain-connection");
  mocks.create
    .mockRejectedValueOnce(new Error("fixture connection failed"))
    .mockResolvedValueOnce({ ready: true });
  await expect(getApi()).rejects.toThrow(/connection failed/);
  expect(mocks.providers[0].disconnect).toHaveBeenCalledOnce();
  await expect(getApi()).resolves.toEqual({ ready: true });
  expect(mocks.providers).toHaveLength(2);
  expect(mocks.providers[1].disconnect).not.toHaveBeenCalled();
});
test("a stalled connection has a bounded retry and releases any API that resolves too late", async () => {
  vi.useFakeTimers();
  const { getApi } = await import("./chain-connection");
  let resolve!: (api: unknown) => void;
  mocks.create.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = getApi();
  const failed = expect(pending).rejects.toThrow(/timed out/);
  await vi.advanceTimersByTimeAsync(30_000);
  await failed;
  expect(mocks.providers[0].disconnect).toHaveBeenCalledOnce();
  const late = { disconnect: vi.fn(async () => {}) };
  resolve(late);
  await vi.advanceTimersByTimeAsync(0);
  expect(late.disconnect).toHaveBeenCalledOnce();
  mocks.create.mockResolvedValueOnce({ ready: true });
  await expect(getApi()).resolves.toEqual({ ready: true });
  expect(mocks.create).toHaveBeenCalledTimes(2);
});
