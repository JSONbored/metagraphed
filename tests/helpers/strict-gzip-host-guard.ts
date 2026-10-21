/**
 * DRAFT host-side defense in depth. Miniflare uses numeric loopback for its
 * local control/dispatch channels. External sockets and all TLS are refused.
 * This is not an OS firewall and does not claim to constrain child processes.
 */
import net from "node:net";
import tls from "node:tls";

export function installHostNetworkGuard() {
  const denied: string[] = [];
  const originalConnect = net.Socket.prototype.connect;
  const originalTlsConnect = tls.connect;
  function fail(target: string): never {
    denied.push(target);
    throw new Error(
      `External networking forbidden in strict gzip test: ${target}`,
    );
  }
  net.Socket.prototype.connect = function (
    this: net.Socket,
    ...args: unknown[]
  ) {
    let first = args[0];
    if (Array.isArray(first)) first = first[0];
    if (typeof first === "object" && first !== null) {
      // Node selects IPC only for a truthy path; an empty string falls back
      // to TCP and must still pass the numeric-loopback host check.
      const path = (first as { path?: unknown }).path;
      if (typeof path !== "string" || path.length === 0) {
        const host = (first as { host?: unknown }).host ?? "127.0.0.1";
        if (host !== "127.0.0.1" && host !== "::1") fail(String(host));
      }
    } else if (
      typeof first === "number" ||
      (typeof first === "string" && Number(first) >= 0)
    ) {
      // Node normalizes nonnegative numeric strings as TCP ports, not paths.
      const host = typeof args[1] === "string" ? args[1] : "127.0.0.1";
      if (host !== "127.0.0.1" && host !== "::1") fail(host);
    } else if (typeof first !== "string") {
      fail("unknown socket connection shape");
    }
    return (
      originalConnect as (this: net.Socket, ...args: unknown[]) => net.Socket
    ).apply(this, args);
  } as typeof originalConnect;
  tls.connect = function (..._args: unknown[]) {
    return fail("TLS connection");
  } as typeof originalTlsConnect;
  return {
    denied,
    restore() {
      net.Socket.prototype.connect = originalConnect;
      tls.connect = originalTlsConnect;
    },
  };
}
