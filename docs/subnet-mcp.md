# Calling a subnet MCP server through Metagraphed

`list_subnet_apis` exposes `mcp` transport metadata for reviewed MCP services.
Use `discover_subnet_mcp` with that service's `surface_id` to negotiate the
provider's protocol and retrieve its live schemas. Call a reviewed read tool with
`read_subnet_mcp`, or a reviewed write tool with `write_subnet_mcp`. An ordinary
HTTP surface remains subject to the existing HTTP caller's schema and admission
rules.

For example, the official Minos assistant configuration documents five public
read tools: `get_current_round`, `get_leaderboard`, `list_recent_rounds`,
`get_miner_history`, and `get_subnet_overview`. Their names are source-bound in
the registry; their argument and output schemas come from MCP discovery. First
discover `sn-107-minos-mcp`, then supply the selected tool's arguments according
to the returned schema. This source evidence establishes the integration
contract, not the provider's current availability.

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
