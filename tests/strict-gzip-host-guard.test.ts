import net from "node:net";
import tls from "node:tls";
import { expect, test, vi } from "vitest";
import { installHostNetworkGuard } from "./helpers/strict-gzip-host-guard.ts";

/**
 * These are classification tests only. Replace the underlying connectors
 * before installing the guard so even a failed assertion cannot open a socket.
 * The receiver has a Socket prototype but no constructed native handle.
 */
function withStubbedConnectors(
  run: (context: {
    connect: (...args: unknown[]) => net.Socket;
    originalConnect: ReturnType<typeof vi.fn>;
    originalTlsConnect: ReturnType<typeof vi.fn>;
    guard: ReturnType<typeof installHostNetworkGuard>;
    socket: net.Socket;
  }) => void,
) {
  const savedConnect = net.Socket.prototype.connect;
  const savedTlsConnect = tls.connect;
  const originalConnect = vi.fn(function (this: net.Socket) {
    return this;
  });
  const originalTlsConnect = vi.fn(() => {
    throw new Error("Synthetic TLS connector must never be reached");
  });
  net.Socket.prototype.connect = originalConnect as typeof savedConnect;
  tls.connect = originalTlsConnect as typeof savedTlsConnect;
  const guard = installHostNetworkGuard();
  const socket = Object.create(net.Socket.prototype) as net.Socket;
  try {
    run({
      connect: (...args) =>
        (
          net.Socket.prototype.connect as (
            this: net.Socket,
            ...args: unknown[]
          ) => net.Socket
        ).apply(socket, args),
      originalConnect,
      originalTlsConnect,
      guard,
      socket,
    });
  } finally {
    guard.restore();
    net.Socket.prototype.connect = savedConnect;
    tls.connect = savedTlsConnect;
  }
}

test.each([
  [
    "empty IPC path with external host",
    [{ path: "", host: "203.0.113.1", port: 80 }],
  ],
  [
    "normalized empty IPC path with external host",
    [[{ path: "", host: "203.0.113.1", port: 80 }, undefined]],
  ],
  ["ordinary external TCP", [{ host: "203.0.113.1", port: 80 }]],
  ["empty IPC path with hostname", [{ path: "", host: "localhost", port: 80 }]],
  ["numeric TCP with external host", [80, "203.0.113.1"]],
  ["numeric-string TCP with external host", ["80", "203.0.113.1"]],
  ["empty-string TCP with external host", ["", "203.0.113.1"]],
  ["unknown connection shape", [null]],
])("refuses %s before the underlying connector", (_name, args) => {
  withStubbedConnectors(({ connect, originalConnect, guard }) => {
    expect(() => connect(...args)).toThrow("External networking forbidden");
    expect(originalConnect).not.toHaveBeenCalled();
    expect(guard.denied).toHaveLength(1);
  });
});

test.each([
  [
    "nonempty IPC path",
    [{ path: "/synthetic/never-opened.sock", host: "203.0.113.1" }],
  ],
  [
    "empty IPC path with IPv4 loopback",
    [{ path: "", host: "127.0.0.1", port: 80 }],
  ],
  ["empty IPC path with IPv6 loopback", [{ path: "", host: "::1", port: 80 }]],
  ["empty IPC path with default loopback", [{ path: "", port: 80 }]],
  ["numeric IPv4 loopback", [80, "127.0.0.1"]],
  ["numeric IPv6 loopback", [80, "::1"]],
  ["numeric default loopback", [80]],
  ["numeric-string IPv4 loopback", ["80", "127.0.0.1"]],
  ["string IPC path", ["/synthetic/never-opened.sock"]],
])("delegates %s only to a synthetic connector", (_name, args) => {
  withStubbedConnectors(({ connect, originalConnect, guard, socket }) => {
    expect(connect(...args)).toBe(socket);
    expect(originalConnect).toHaveBeenCalledExactlyOnceWith(...args);
    expect(guard.denied).toEqual([]);
  });
});

test("refuses TLS and restores the captured synthetic connectors", () => {
  withStubbedConnectors(({ originalConnect, originalTlsConnect, guard }) => {
    expect(() => tls.connect({ host: "127.0.0.1", port: 443 })).toThrow(
      "External networking forbidden",
    );
    expect(originalTlsConnect).not.toHaveBeenCalled();
    expect(guard.denied).toEqual(["TLS connection"]);
    guard.restore();
    expect(net.Socket.prototype.connect).toBe(originalConnect);
    expect(tls.connect).toBe(originalTlsConnect);
  });
});
