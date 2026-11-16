import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { GRAPHQL_TRANSPORT_WS_PROTOCOL } from "graphql-ws";
import { CHAIN_FIREHOSE_CAP_HEADER } from "../workers/chain-firehose-hub.ts";
import type { NativeHttpUpgrade } from "./native-http-server.ts";
import type {
  createNativeChainFirehose,
  NativeChainSocket,
} from "./native-chain-firehose.ts";

type ChainService = Awaited<ReturnType<typeof createNativeChainFirehose>>;
export interface NativeChainWebSocketOptions {
  closeGraceMillis: number;
  onError(error: unknown): void;
}

function messageBytes(data: RawData): Buffer {
  return Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data);
}

/** Native ws noServer integration. This owns socket admission and closure;
 * the application retains its shared chain adapter through request drain. */
export function createNativeChainWebSocketTransport(
  chain: ChainService,
  requested: NativeChainWebSocketOptions,
): NativeHttpUpgrade {
  const options = { ...requested };
  if (
    !Number.isSafeInteger(options.closeGraceMillis) ||
    options.closeGraceMillis < 1 ||
    options.closeGraceMillis > 10000 ||
    typeof options.onError !== "function"
  )
    throw new RangeError("Native WebSocket bounds and reporter are required");
  const report = (error: unknown) => {
    try {
      options.onError(error);
    } catch {
      /* Reporting cannot retain a socket. */
    }
  };
  const server = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    perMessageDeflate: false,
    maxPayload: chain.maxMessageBytes,
    handleProtocols: (protocols) =>
      protocols.has(GRAPHQL_TRANSPORT_WS_PROTOCOL)
        ? GRAPHQL_TRANSPORT_WS_PROTOCOL
        : false,
  });
  const connections = new Set<WebSocket>();
  let open = true;
  let closing: Promise<void> | undefined;
  const reject = async (socket: Duplex, response: Response) => {
    if (socket.destroyed || socket.writableEnded) return;
    const body = Buffer.from(await response.arrayBuffer());
    const headers = new Headers(response.headers);
    headers.delete(CHAIN_FIREHOSE_CAP_HEADER);
    headers.set("content-length", String(body.byteLength));
    headers.set("connection", "close");
    const reason = response.statusText || "Upgrade rejected";
    socket.end(
      Buffer.concat([
        Buffer.from(
          `HTTP/1.1 ${response.status} ${reason}\r\n${[...headers].map(([key, value]) => `${key}: ${value}\r\n`).join("")}\r\n`,
        ),
        body,
      ]),
    );
  };
  const connect = (incoming: IncomingMessage, socket: Duplex, head: Buffer) =>
    new Promise<NativeChainSocket>((resolve, rejectConnection) => {
      const failed = (error: unknown) => {
        cleanup();
        rejectConnection(error);
      };
      const closed = () =>
        failed(new Error("Upgrade socket closed before admission"));
      const cleanup = () => {
        socket.removeListener("error", failed);
        socket.removeListener("close", closed);
      };
      socket.once("error", failed);
      socket.once("close", closed);
      try {
        server.handleUpgrade(incoming, socket, head, (webSocket) => {
          cleanup();
          if (!open) {
            webSocket.terminate();
            rejectConnection(
              new Error("Native WebSocket transport is closing"),
            );
            return;
          }
          connections.add(webSocket);
          webSocket.once("close", () => connections.delete(webSocket));
          webSocket.on("error", report);
          resolve({
            get bufferedBytes() {
              return webSocket.bufferedAmount;
            },
            send(value) {
              if (webSocket.readyState !== WebSocket.OPEN)
                throw new Error("Native WebSocket is not open");
              webSocket.send(value, (error) => {
                if (error) {
                  report(error);
                  webSocket.terminate();
                }
              });
            },
            close(code, reason) {
              webSocket.close(code, reason);
            },
            onMessage(callback) {
              webSocket.on("message", (data, binary) => {
                const bytes = messageBytes(data);
                callback(
                  binary ? Uint8Array.from(bytes).buffer : bytes.toString(),
                );
              });
            },
            onClose(callback) {
              webSocket.once("close", (code, reason) =>
                callback(code, reason.toString()),
              );
            },
          });
        });
      } catch (error) {
        failed(error);
      }
    });
  const closeSockets = async () => {
    const selected = [...connections];
    if (selected.length === 0) return;
    const finished = Promise.all(
      selected.map(
        (webSocket) =>
          new Promise<void>((resolve) => {
            if (webSocket.readyState === WebSocket.CLOSED) {
              resolve();
              return;
            }
            webSocket.once("close", () => resolve());
            webSocket.close(1012, "chain transport is closing; reconnect");
          }),
      ),
    );
    const timer = setTimeout(() => {
      for (const webSocket of selected)
        if (webSocket.readyState !== WebSocket.CLOSED) webSocket.terminate();
    }, options.closeGraceMillis);
    try {
      await finished;
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    async handle(request, incoming, socket, head) {
      const path = new URL(request.url).pathname;
      if (!open || chain.state !== "ready") {
        await reject(
          socket,
          new Response("Chain transport unavailable", { status: 503 }),
        );
        return;
      }
      if (path !== "/api/v1/chain/stream" && path !== "/api/v1/graphql") {
        await reject(socket, new Response("Not found", { status: 404 }));
        return;
      }
      const response = await chain.openSocket(request, () =>
        connect(incoming, socket, head),
      );
      if (response) await reject(socket, response);
    },
    close() {
      if (closing) return closing;
      open = false;
      closing = closeSockets().then(
        () =>
          new Promise<void>((resolve, rejectClose) =>
            server.close((error) => (error ? rejectClose(error) : resolve())),
          ),
      );
      void closing.catch(() => {
        closing = undefined;
      });
      return closing;
    },
  };
}
