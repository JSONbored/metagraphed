// Client→upstream wss piping with connect-time failover (extracted for testing).
import { WebSocket } from "ws";

import {
  MAX_RPC_BODY_BYTES,
  SAFE_RPC_METHODS,
  DENIED_RPC_PREFIXES,
} from "../../../workers/config.mjs";

function isSafeRpcMethod(method) {
  return (
    SAFE_RPC_METHODS.has(method) &&
    !DENIED_RPC_PREFIXES.some((prefix) => method.startsWith(prefix))
  );
}

function rpcError(id, code, message) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  });
}

function validateClientFrame(data, isBinary) {
  if (isBinary)
    return {
      ok: false,
      reply: rpcError(
        null,
        -32600,
        "Binary JSON-RPC frames are not supported.",
      ),
    };
  const size = Buffer.isBuffer(data)
    ? data.length
    : Buffer.byteLength(String(data));
  if (size > MAX_RPC_BODY_BYTES) {
    return {
      ok: false,
      reply: rpcError(
        null,
        -32600,
        "RPC request body is too large for the read-only proxy.",
      ),
    };
  }
  let rpc;
  try {
    rpc = JSON.parse(data.toString());
  } catch {
    return {
      ok: false,
      reply: rpcError(null, -32700, "RPC frame must be valid JSON."),
    };
  }
  if (
    !rpc ||
    Array.isArray(rpc) ||
    typeof rpc !== "object" ||
    typeof rpc.method !== "string"
  ) {
    return {
      ok: false,
      reply: rpcError(
        rpc?.id,
        -32600,
        "Only single JSON-RPC request objects are supported.",
      ),
    };
  }
  if (!isSafeRpcMethod(rpc.method)) {
    return {
      ok: false,
      reply: rpcError(
        rpc.id,
        -32601,
        `RPC method is not allowed through this proxy: ${rpc.method}`,
      ),
    };
  }
  return { ok: true };
}

// Pipe a client wss connection to the first healthy upstream, failing over to the
// next on a failed handshake. The client listeners attach ONCE; `up` is the
// current upstream socket, reassigned per attempt.
//
// Failover correctness (regression-tested in test/proxy.test.mjs): on a failed
// handshake `ws` emits BOTH 'error' AND 'close'. A per-attempt `settled` flag —
// plus detaching + terminating the failed socket before advancing — makes each
// attempt advance EXACTLY once. Without it both handlers dial the next upstream
// (a duplicate, orphaned connection), and the reassigned `up` can be a still-
// CONNECTING socket when a prior dial's 'open' flushes `pending`, throwing an
// uncaught "WebSocket is not open" that crashes the whole process (killing every
// other proxied client). The flush is also try/catch'd as defense in depth.
export function proxy(client, upstreams, opts = {}) {
  const handshakeTimeout = opts.handshakeTimeout ?? 10000;
  let up = null;
  let opened = false;
  let clientClosed = false;
  const pending = [];

  client.on("message", (data, isBinary) => {
    const validation = validateClientFrame(data, isBinary);
    if (!validation.ok) {
      if (client.readyState === WebSocket.OPEN) client.send(validation.reply);
      return;
    }
    if (opened && up && up.readyState === WebSocket.OPEN)
      up.send(data, { binary: false });
    else pending.push([data, false]);
  });
  client.on("close", () => {
    clientClosed = true;
    try {
      up?.close();
    } catch {
      /* noop */
    }
  });
  client.on("error", () => {
    clientClosed = true;
    try {
      up?.terminate();
    } catch {
      /* noop */
    }
  });

  const tryUpstream = (attempt) => {
    if (clientClosed) return;
    if (attempt >= upstreams.length) {
      try {
        client.close(1013, "no upstream available");
      } catch {
        /* already closed */
      }
      return;
    }
    const sock = new WebSocket(upstreams[attempt], { handshakeTimeout });
    up = sock;
    let settled = false; // this attempt opens OR advances exactly once

    // Pre-open failure → advance once, after neutralizing the dead socket so its
    // trailing event (error→close, or vice versa) can't re-enter.
    const advance = () => {
      if (settled) return;
      settled = true;
      try {
        sock.removeAllListeners();
      } catch {
        /* noop */
      }
      try {
        sock.terminate();
      } catch {
        /* noop */
      }
      tryUpstream(attempt + 1);
    };

    sock.on("open", () => {
      // A late-opening socket we've already failed past (or a closed client):
      // close it rather than pipe into stale state.
      if (settled || clientClosed) {
        try {
          sock.terminate();
        } catch {
          /* noop */
        }
        return;
      }
      settled = true;
      opened = true;
      try {
        for (const [data, isBinary] of pending)
          sock.send(data, { binary: isBinary });
      } catch {
        /* racing/closing socket — the client will retry */
      }
      pending.length = 0;
      sock.on("message", (data, isBinary) => {
        if (client.readyState === WebSocket.OPEN)
          client.send(data, { binary: isBinary });
      });
      sock.on("close", () => {
        try {
          client.close();
        } catch {
          /* noop */
        }
      });
      sock.on("error", () => {
        try {
          client.close();
        } catch {
          /* noop */
        }
      });
    });
    sock.on("close", advance);
    sock.on("error", advance);
  };

  tryUpstream(0);
}
