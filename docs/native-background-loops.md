# Native application background loops

`createNativeBackgroundLoops` prepares the recurring owner for the public native
application. Construction validates and captures capabilities, cadences and
limits; it opens no connection, registers no schedule and starts no timer.
`start(boundary)` explicitly registers the cron start boundary, then starts the
following finite turns:

| Turn                                  | Capability and ownership                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Cron planning                         | `createPgCronScheduler.plan`, using its declared exact inventory and database clock                           |
| Cron execution                        | `createPgCronDispatcher`, routing to the existing API, data and registry owner ports                          |
| Queue execution                       | `createPgQueueDispatcher`, covering all six `PG_QUEUE_NAMES` at the concurrency from the durable queue policy |
| MCP session alarms                    | `createNativeMcpSessions.runDueAlarms`, with a required bounded batch size                                    |
| Chain alarms and head polling         | `createNativeChainFirehose.runDueAlarm`; the chain core retains its existing head-poll policy                 |
| RPC capture persistence and retention | `createPgRpcUsageStore.flush` and `prune`, on independent cadences                                            |
| Authentication retention              | `createNativeAuthControls.pruneExpiredRates`, with a required bounded batch size                              |

Each runner starts its next delay after its previous turn settles. It cannot
overlap itself or accumulate a catch-up queue. Different queue workers retain
their existing queue-specific concurrency. The scheduler and transports still
enforce their own durable leases, deadlines and admission limits. Cron runner
count must agree with the supplied scheduler policy in the final source
manifest. MCP and chain owner renewal timers remain owned by their services.
Subnet status notifications and alerter calls are bounded service operations;
they do not need another periodic evaluator here.

Every cadence is explicit and between 10 milliseconds and one hour. The caller
chooses values suitable for the expected workload and database budget. Failure
is reported with its loop name and counted; the next attempt waits for the same
configured delay. A broken reporter cannot erase the failed-work count or stop
other turns. The loop owner does not replace an absent capability with a no-op.
Methods, receiver identities, limits and cadences are captured at construction.

## Application lifecycle

Construct the stores and loop owner from the same verified native source map
used by `createNativeApplication`. The cron/queue owner ports are its returned
`owners`. Keep `start` outside the application composition callback: those ports
exist only after application construction, and startup must not dispatch jobs
before the capability manifest and OAuth setup are accepted. Schedule
registration is an explicit persistent write. Its boundary requires reviewed
source custody; this module does not choose the production cutover clock.

Tie the application's `stop` callback to this owner's `stop`, retaining the
stores and service handles. Stop clears pending timers synchronously and waits
for admitted turns, including an unfinished schedule registration. A stop during
registration cannot start new turns afterward. Repeated starts only accept the
same boundary while starting/running; a stopped instance cannot restart.

The stop deadline reports unfinished work, keeps the state at `stopping` and
retains the actual operation promises. It does not declare those operations
complete or close their PostgreSQL pool. A later stop can retry the drain. The
application then drains admitted requests and closes its adapters. Close the
RPC store only after request drain so its final flush includes all accepted
events. Queue, cron, session, chain, alerter and other adapters must finish their
own cleanup before the application closes the shared pool. The loop owner
deliberately never closes those adapters itself.

This is prepared public-application lifecycle code. It does not supply the final
environment/source manifest, restore data, start a listener, change routing or
activate a replacement owner. Private poller/decoder workflow scheduling remains
a separate owner. Source transfer, pending queue/cron/actor custody and exact
read/write acceptance remain required before disabling Cloudflare execution.
