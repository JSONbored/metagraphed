import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { createAdaptorServer } from "@hono/node-server";
import { beforeEach, describe, test, vi } from "vitest";
import type { NativeApiProcess } from "../src/native-api-process.ts";
import {
  listenNativeApi,
  type NativeHttpOptions,
} from "../src/native-http-server.ts";

type AdapterOptions = Parameters<typeof createAdaptorServer>[0];
const faults = vi.hoisted(() => ({
  listen: null as Error | null,
  close: null as Error | null,
  deferClose: false,
  finishClose: undefined as (() => void) | undefined,
  fetch: undefined as AdapterOptions["fetch"] | undefined,
  server: undefined as
    { emit(event: string, error: Error): boolean } | undefined,
}));
vi.mock("@hono/node-server", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    createAdaptorServer(options: AdapterOptions) {
      faults.fetch = options.fetch;
      const server = new (class extends EventEmitter {
        listen(_port: number, _host: string, callback: () => void) {
          if (faults.listen) this.emit("error", faults.listen);
          else callback();
        }
        address() {
          return { address: "127.0.0.1", family: "IPv4", port: 1234 };
        }
        close(callback: (error?: Error) => void) {
          faults.finishClose = () => callback(faults.close ?? undefined);
          if (!faults.deferClose) faults.finishClose();
        }
      })();
      faults.server = server;
      return server;
    },
  };
});
beforeEach(() => {
  faults.listen = null;
  faults.close = null;
  faults.deferClose = false;
  faults.finishClose = undefined;
});
const options: NativeHttpOptions = {
  origin: "https://api.fixture.invalid",
  hostname: "127.0.0.1",
  port: 0,
  maxRequestBytes: 8,
  requestTimeoutMillis: 1000,
  headersTimeoutMillis: 1000,
  onError() {},
};
function fixture(): NativeApiProcess<string, string> {
  return {
    state: "ready",
    async fetch() {
      return new Response("ok");
    },
    async scheduled() {},
    async queue() {},
    async close() {},
  };
}

describe("native HTTP lifecycle failures", () => {
  test("closes the process when the listener cannot bind", async () => {
    const process = fixture();
    let closed = 0;
    process.close = async () => {
      closed += 1;
    };
    faults.listen = new Error("address in use");
    await assert.rejects(listenNativeApi(process, options), /address in use/);
    assert.equal(closed, 1);
  });

  test("preserves no trusted identity when a connection has no peer address", async () => {
    const process = fixture();
    process.fetch = async (request) => {
      assert.equal(request.headers.get("cf-connecting-ip"), null);
      return new Response("ok");
    };
    const listener = await listenNativeApi(process, options);
    const incoming = new IncomingMessage(new Socket());
    const result = await faults.fetch!(
      new Request("https://forged.invalid/", {
        headers: { "cf-connecting-ip": "forged" },
      }),
      { incoming, outgoing: new ServerResponse(incoming) },
    );
    assert.ok(result instanceof Response);
    assert.equal(await result.text(), "ok");
    await listener.close();
  });

  test("reports failed listener cleanup while preserving the bind failure", async () => {
    const process = fixture();
    process.close = async () => {
      throw new Error("cleanup failed");
    };
    faults.listen = new Error("bind failed");
    const reported: unknown[] = [];
    await assert.rejects(
      listenNativeApi(process, {
        ...options,
        onError(error) {
          reported.push(error);
        },
      }),
      /bind failed/,
    );
    assert.equal((reported[0] as Error).message, "cleanup failed");
  });

  test("reports an HTTP listener close failure", async () => {
    faults.close = new Error("close failed");
    const listener = await listenNativeApi(fixture(), options);
    await assert.rejects(listener.close(), /close failed/);
  });

  test("surfaces the process deadline while the HTTP connection is still draining", async () => {
    const process = fixture();
    let first = true;
    process.close = async () => {
      if (first) {
        first = false;
        throw new Error("drain deadline");
      }
    };
    faults.deferClose = true;
    const listener = await listenNativeApi(process, options);
    await assert.rejects(listener.close(), /drain deadline/);
    faults.finishClose!();
    await listener.close();
  });

  test("contains errors thrown by the server error reporter", async () => {
    const listener = await listenNativeApi(fixture(), {
      ...options,
      onError() {
        throw new Error("reporter failed");
      },
    });
    assert.doesNotThrow(() =>
      faults.server!.emit("error", new Error("connection failed")),
    );
    await listener.close();
  });

  test("requires an explicit error reporter", async () => {
    const invalid = Object.assign({}, options, { onError: undefined });
    await assert.rejects(
      listenNativeApi(fixture(), invalid as unknown as NativeHttpOptions),
      /error reporter is required/,
    );
  });
});
