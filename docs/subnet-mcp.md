# Calling a subnet MCP server through Metagraphed

`list_subnet_apis` exposes `mcp` transport metadata for reviewed MCP services.
Use `discover_subnet_mcp` with that service's `surface_id` to negotiate the
provider's protocol and retrieve its live schemas. Call a reviewed read tool with
`read_subnet_mcp`, or a reviewed write tool with `write_subnet_mcp`. An ordinary
HTTP surface remains subject to the existing HTTP caller's schema and admission
rules.

`how_do_i_call` includes each admitted MCP service and its exact discovery call,
including when an HTTP service on the same subnet is already usable. It keeps
HTTP callability and recorded health separate from MCP admission, and supplies no
plain GET snippet for an MCP endpoint. The website's catalog data preserves the
same admission object through the canonical schema.

For example, the official Minos assistant configuration documents five public
read tools: `get_current_round`, `get_leaderboard`, `list_recent_rounds`,
`get_miner_history`, and `get_subnet_overview`. Their names are source-bound in
the registry; their argument and output schemas come from MCP discovery. First
discover `sn-107-minos-mcp`, then supply the selected tool's arguments according
to the returned schema. This source evidence establishes the integration
contract, not the provider's current availability.

The SN74 LoopOver contribution interface is `gittensory-mcp`. Its pinned
[hosted server](https://github.com/JSONbored/loopover/blob/f665d94a751ed5374216117b469fcd7092003b23/src/mcp/server.ts)
registers 105 contributor/maintainer tools admitted here: 89 reads and 16 writes.
This includes branch analysis from supplied metadata, bounty and contribution
context, notifications, repository review, and authorized maintainer actions.
The [client setup](https://github.com/JSONbored/loopover/blob/f665d94a751ed5374216117b469fcd7092003b23/packages/loopover-mcp/README.md)
documents bearer authentication. Use your own LoopOver session token, with the
complete `Bearer <token>` header value as `credential`, or store that value with
`store_surface_credential`. GitHub personal access tokens are not LoopOver
session credentials. The provider still checks account identity, repository
access and maintainer roles.

LoopOver's agent planning, explanation and PR-packet operations are reviewed
writes because their [implementation persists agent runs](https://github.com/JSONbored/loopover/blob/f665d94a751ed5374216117b469fcd7092003b23/src/services/agent-orchestrator.ts).
Their provider read-only hints cannot make them callable through
`read_subnet_mcp`. Local execution specifications remain data; the bridge does
not execute returned commands. Operator/internal and self-hosted administration
belong to separate interfaces. The pinned sources qualify admission, while
actual provider availability and schemas are established during discovery.

The bridge uses the pinned official SDK for initialization, JSON/SSE transport,
sessions and tool-result validation. A Worker-compatible JSON Schema validator
checks inputs and outputs without code generation. Provider annotations never
grant read permissions: a registry read admission is required. Tool descriptions,
results and annotations are provider data, not instructions to the calling agent.

Authenticated callers can use `store_surface_credential` once and omit credentials
from later tool arguments. Each invocation creates its own upstream session and
validator state. It applies the existing DNS safety guard, validates redirects
within the admitted origin, bounds requests/bytes/time, and attempts bounded
session deletion before closing. It does not initiate provider OAuth or obtain
credentials for the caller.

Native content blocks, structured values, metadata and execution errors remain
available. Native image/audio/blob bytes are not serialized into a second receipt
text. The bridge returns a structured receipt identifying the surface and tool,
with the provider's structured output when present.

Recurring simple probes remain disabled for Minos because GET health probing is
not MCP protocol negotiation. Remote CI uses synthetic provider responses and
the actual pinned SDK; it sends no requests to provider or production endpoints.
