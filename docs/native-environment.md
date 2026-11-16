# Complete native environment

`createNativeEnvironment` is the concrete owner of the application's native
capabilities. It calls one `createNativeApplication` and constructs its stores
from the verified `app`, `auth`, `jobs`, `realtime`, `retained`, and `search`
sources. The retained view has its own read-only declaration. Source identity,
table ownership and permissions are checked before construction; generated-ID
sequences additionally require `USAGE` or `UPDATE`, without allocating an ID.

The caller supplies explicit scalar settings, credentials, directory paths,
model identities and resource budgets. It cannot supply replacement stores or
an environment-validation callback. Unknown settings and object-valued settings
fail. Reviewed active feature flags retain their existing values. Credentials
used by internal calls must agree with their destination owner, and an active
stored alert channel requires its delivery credentials.

All account, neuron, registry, generated-artifact, observation, lane-health,
concentration, self-health, RPC-usage, raw-capture, retention, retained-block,
state-export and producer capabilities use those same sources. The API's
`CONTROL_KV_STORE` and legacy `METAGRAPH_CONTROL` name point to the same real
PostgreSQL control store because existing consumers use both names. OAuth grant
and pending-state namespaces remain separate. No D1, Hyperdrive, Durable Object,
physical R2, Workers AI, Vectorize or Analytics Engine stand-ins are created.

The factory creates immutable API static assets, the native archive catalog and
filesystem content adapter, explicit inference transport, and a matching
semantic index. It refuses an embedding model or dimension mismatch. The
reviewed native OAuth module remains responsible for OAuth protocol behavior.

Status, alerter, chain and MCP services are constructed in dependency order.
The forward MCP reference rejects use before binding. Actor alarm maintenance
enters the application's normal bounded background-job scope, so internal data
calls keep their owner, cancellation and drain behavior. Queue transport covers
all six existing queues; cron uses the exact existing dispatcher inventory.

Construction starts no HTTP listener, cron scanner, queue consumer or actor
alarm loop. `startBackground(boundary)` explicitly registers the scheduler
boundary and starts maintenance. The native actor owners retain their own
bounded lease-renewal lifecycles once constructed.

An explicit caller can pass the returned environment directly to
`listenNativeApi`. Its listener requires only the real state, fetch and close
ports. `createNativeChainWebSocketTransport(environment.chain, limits)` owns
upgrade admission and sockets; the environment retains the shared chain service
until admitted HTTP and background work has drained. A failed listener bind
closes the transport and the environment through the same retryable owners.

### Client identity behind an HTTP proxy

The listener uses the TCP peer as the client identity by default and discards
incoming forwarding and Cloudflare headers. When a trusted HTTP proxy terminates
TLS, pass an explicit policy to `listenNativeApi`:

```ts
clientIdentity: {
  trustedProxyAddresses: ["192.0.2.10", "2001:db8::10"],
}
```

Use the proxy's actual socket addresses in place of these documentation addresses.
The policy accepts 1–32 distinct IP literals, normalizes IPv4-mapped IPv6, and
rejects hostnames, CIDRs, zone IDs and unspecified addresses. It is copied before
the listener starts. Peers outside the list retain socket-derived identity.

The proxy must **overwrite** `X-Real-IP` with the original client's connection
address, rather than forwarding a client-supplied claim. For example, an Nginx
location can use `proxy_set_header X-Real-IP $remote_addr;`. Restrict access to a
private origin listener separately when deploying behind private ingress.

A listed peer must supply exactly one valid IP in `X-Real-IP`. Absent, duplicate,
comma-separated or invalid claims receive HTTP 400 on ordinary requests;
WebSocket upgrades are closed before admission. All forwarding and Cloudflare
headers are still removed. Only the
validated client address becomes the existing internal `cf-connecting-ip` value,
so HTTP and WebSocket rate limits use the same identity without trusting those
headers directly. The configured public origin remains authoritative.

Each adapter registers cleanup immediately. Shutdown first stops recurring
admission, drains admitted requests/jobs, then closes adapters in reverse
construction order before the single PostgreSQL pool. Partial construction or
failed cleanup retains a retryable cleanup owner; a timeout does not authorize
closing the pool beneath unfinished work.

This factory does not transfer data, load migrations, provision credentials,
select production storage paths, publish a service, or change DNS/routing.
Production activation still requires complete source and file custody, a
portable runtime package, listener/TLS integration, live read/write acceptance,
and a verified rollback path.
