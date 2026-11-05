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
