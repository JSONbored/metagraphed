# Native application assembly

`createNativeApplication` composes the real main API, data API and registry
handlers over one `createNativeApiProcess`. It is preparation: it creates no
listener, changes no routes, starts no schedule scanner or queue consumer, and
migrates no data. Source readiness covers only the supplied relation manifest.

The caller supplies all process and internal-call limits, source definitions,
the KV factory, a reviewed native OAuth module and its writable source name,
and a composition callback. The callback receives only verified scoped sources,
the two selected KV stores, and process-owned data/registry service handles.
There are no connection strings hidden behind service bindings or per-owner
processes. The main API, internal data and registry ports, cron owners and queue
families share one request/job admission controller and one pool close.

The callback returns the three environments, a complete capability-manifest
validator and idempotent adapter stop/drain functions. It must select the exact provided
`DATA_API` and `REGISTRY_SYNC_API` handles on the main environment. The assembly
rejects D1, Hyperdrive, Durable Object, Workers AI, Vectorize, Analytics Engine,
physical R2 and history-asset Worker bindings. It also rejects selected D1 table
names. The manifest validator runs before request admission; it must check every
reader/writer family, the identity of shared auth controls, source ownership and
required secrets. A permissive validator does not establish runtime closure.
Validated environments are shallow snapshots with frozen top-level bindings;
caller mutation cannot later install a legacy binding. Capability internals
remain mutable. Service references and source/OAuth configuration are also
captured before asynchronous construction begins.

The existing Worker deployment environment types still require platform
bindings. The assembly has one explicit type boundary after the caller's
manifest validation; it does not construct dummy platform objects to satisfy
those types. Handler contexts use the shared `AppExecutionContext` and
`AppScheduledEvent` capabilities. Cloudflare's existing context/controller
objects continue to satisfy those narrower types without a runtime change.

Internal service fetches run in the originating request or job's asynchronous
scope. They retain its cancellation signal, background work and shared call
budget. A depth limit bounds recursive calls. Explicit request and response byte
limits, response chunk limits and a total deadline bound buffering. A process-wide
concurrency limit rejects excess calls without a waiting queue. The aggregate
buffer budget is at most 64 MiB and accounts conservatively for three copies of
both request and response buffers per admitted call. Slots remain occupied until
the underlying handler and cancellation cleanup settle, including after caller
timeout. Bodies are
copied before returning their response, preserving the status, status text,
headers and bytes. These data/registry services are finite internal HTTP calls;
the main response's SSE stream stays on the native process streaming path.

An internal call outside an active invocation fails. The native context remains
active until its response body and registered background work finish, including
background work registered by other background work. A timed-out internal
handler can return an error promptly while its unfinished operation remains in
the process drain. A deadline does not turn unfinished work into completion.

The returned `owners` ports supply the exact `scheduled(event, signal)` and
`queue(batch, signal)` contracts consumed by the PostgreSQL dispatchers. Queue
names are checked against the six declared families, and sync queues route to
data while webhook/probe queues route to the main API. Registry and data fetch
ports invoke their own handlers without crossing the public OAuth dispatcher.
These are internal capabilities; a later listener must expose only the main
`fetch` unless another authenticated boundary is separately reviewed.

The `background(owner, operation, signal)` port admits finite actor maintenance
through that same job limit and shutdown drain. Its callback receives an active
native execution context and can use the process-owned internal services. This
is the entrypoint for alarm work that can call another application owner; a
standalone callback outside an invocation has no internal service scope.
Registered background work finishes before this port settles, and a failure
propagates to its caller. It creates no loop or listener by itself.

Composition also receives `onStartupCleanup`. Register an adapter immediately
after constructing it, so a later construction failure cannot bypass its
cleanup while the process closes PostgreSQL. The callback supplements the
returned bindings' stop/close ownership; cleanup functions must be idempotent.

On close, the process stops request/job admission, calls `stop` to stop recurring
and external adapter work, waits for admitted invocations, calls `close` to
drain/close adapters, and then closes PostgreSQL once. `stop` must preserve all
capabilities needed by existing requests and background work; an admitted
request may still make an internal data/registry call. Neither callback may
await this same process's `close()` or try to admit a new job. A rejected stop or
adapter drain leaves the pool open and admission stopped so a later close can
retry. Startup registers the returned bindings' stop/close immediately, so a
later manifest or OAuth setup failure drains those bindings before the pool.
`NativeStartupCleanupError` indicates that cleanup failed or exceeded its
deadline; its `close()` handle retries cleanup while retaining the shared pool.
The composition callback owns cleanup if it throws before returning its
lifecycle functions.

## Remaining source and lifecycle closure

The source manifest is a separate reviewable input. It must select the prepared
account, neuron snapshot/history/metric/aggregate, retained-block, archive,
lane-health, KV, OAuth, auth-rate, semantic/AI, realtime and RPC-usage capabilities
as complete reader/writer families. Their constructors receive the same scoped
source map; no constructor should create another pool.

The main `producerStore` and generic `neonWriteRunner` selectors still contain
D1/Hyperdrive paths. Every enabled native producer must first select an explicit
shared-pool writer, including the registry and remaining native capture lanes.
Rejecting legacy bindings cannot by itself make an unconverted writer work.

The lifecycle owner still needs the bounded queue/cron loops, actor alarm
scanners, chain head loop, WebSocket transport, static/history content hosting,
shutdown ordering and actual source/credential configuration. Infra poller and
decoder containers plus the nine Workflow schedules remain separate owners.
Source transfer, pending work custody, exact byte/read/write acceptance,
deployment and traffic cutover remain required before removing Cloudflare.
