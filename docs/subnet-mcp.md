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

A source-reviewed service can declare `mcp.public_discovery: true` when its
catalog is public while execution requires a key. Discovery then omits stored
credentials and their private KV lookup. An explicit caller credential still
receives the usual validation and is forwarded. Read/write tools, prompts and
resources retain their authentication requirements. Omission or `false` keeps
the existing discovery requirement; tool arguments cannot override this registry
decision.

Discovery also returns source-reviewed `prompts` and `resources` when the registry
admits them. Use `get_subnet_mcp_prompt` with its exact `prompt_name` and string
arguments, or `read_subnet_mcp_resource` with its exact `resource_uri`. A resource
URI is an identifier for the admitted MCP server, not a URL the bridge fetches.
Prompt receipts retain each message's role and its zero-based `content_index`;
resource receipts map each returned URI to the corresponding native content block.
Text, images, audio and embedded resource bytes occur once in native content.

For example, the official Minos assistant configuration documents five public
read tools: `get_current_round`, `get_leaderboard`, `list_recent_rounds`,
`get_miner_history`, and `get_subnet_overview`. Their names are source-bound in
the registry; their argument and output schemas come from MCP discovery. First
discover `sn-107-minos-mcp`, then supply the selected tool's arguments according
to the returned schema. This source evidence establishes the integration
contract, not the provider's current availability.

SN22 Desearch's official hosted service, `sn-22-desearch-mcp`, admits all 15 read
tools in the pinned server: AI, web and X search; web and X link search; X posts,
users, replies, retweeters and trends; page extraction; and legacy web crawling.
Its [hosted setup](https://github.com/Desearch-ai/mcp-desearch/blob/a99cfecd5d9242c407f1cca9ea73c2b2abec2c42/README.md),
[tool implementation](https://github.com/Desearch-ai/mcp-desearch/blob/a99cfecd5d9242c407f1cca9ea73c2b2abec2c42/server.ts)
and [HTTP handler](https://github.com/Desearch-ai/mcp-desearch/blob/a99cfecd5d9242c407f1cca9ea73c2b2abec2c42/http.ts)
establish public discovery and caller-key execution. Discover the service first,
then supply your Desearch API key as `credential` or store it once; the declared
placement is `x-api-key`. Provider charges and limits belong to that key. Live
discovery supplies the argument schemas, including repeated URL collections.
Source qualification does not assert current provider availability.

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

The same pinned server declares four read-only contributor planning prompts and
two JSON taxonomy resources: `loopover://finding-taxonomy` and
`loopover://enrichment-analyzers`. The URI declarations are in
[finding taxonomy](https://github.com/JSONbored/loopover/blob/f665d94a751ed5374216117b469fcd7092003b23/src/review/finding-taxonomy.ts)
and [enrichment analyzers](https://github.com/JSONbored/loopover/blob/f665d94a751ed5374216117b469fcd7092003b23/src/review/enrichment-analyzers-taxonomy.ts).
These prompts are advisory text; retrieving one does not execute its instructions.

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

Successful catalog POST responses can use the existing one-megabyte invocation
byte budget. Initialization, independent GET/SSE streams, operation results and
HTTP error bodies retain their 256-KiB response limit. Catalog pages, prompts,
resources and results still share that same one-megabyte total; a larger catalog
does not grant another byte budget. The published LoopOver contract fixture
includes 163 tool contracts and a 262,655-byte conservative catalog, without
asserting that every conditional tool is enabled in the hosted deployment.

Native content blocks, structured values, metadata and execution errors remain
available. Native image/audio/blob bytes are not serialized into a second receipt
text. The bridge returns a structured receipt identifying the surface and tool,
with the provider's structured output when present.

Recurring simple probes remain disabled for Minos because GET health probing is
not MCP protocol negotiation. Remote CI uses synthetic provider responses and
the actual pinned SDK; it sends no requests to provider or production endpoints.
