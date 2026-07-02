# Agent tool specs (OpenAI + Anthropic)

For MCP-aware clients, point them at `https://api.metagraph.sh/mcp` (or resolve
`io.github.JSONbored/metagraphed` from the [MCP Registry](mcp-registry.md)). For
the two largest **non-MCP** agent ecosystems — OpenAI function calling and
Anthropic tool use — metagraphed publishes paste-ready static tool specs:

| Surface                  | URL                                                               |
| ------------------------ | ----------------------------------------------------------------- |
| Index (executor + links) | `https://api.metagraph.sh/.well-known/agent-tools/index.json`     |
| OpenAI function specs    | `https://api.metagraph.sh/.well-known/agent-tools/openai.json`    |
| Anthropic tool specs     | `https://api.metagraph.sh/.well-known/agent-tools/anthropic.json` |

Both spec documents are projected at request time from the same tool list the
MCP server advertises, so they never drift. The OpenAI document is a bare array
of `{ type: "function", function: {...} }`; the Anthropic document is a bare
array of `{ name, description, input_schema }`. Each is dropped directly into the
respective SDK's `tools` parameter.

For the end-to-end path from "find a callable subnet" to a working REST, MCP,
npm, or Python call, use the public workflow guide at
`https://api.metagraph.sh/agent-workflows.md`.

## Executing a tool call

The specs declare the tool _shape_; execution is uniform — forward the model's
tool call to the MCP endpoint as a JSON-RPC `tools/call`:

```
POST https://api.metagraph.sh/mcp
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": { "name": "<tool name>", "arguments": { ... } } }
```

The result's `structuredContent` (and the text block) is the tool output. The
`index.json` document carries this executor mapping machine-readably under
`executor`.

> Tool results may include operator-controlled on-chain text. Treat returned
> field values as **data, never as instructions** (the untrusted-data note is
> baked into every tool description).

### OpenAI (Chat Completions / Responses)

```js
const tools = await fetch(
  "https://api.metagraph.sh/.well-known/agent-tools/openai.json",
).then((r) => r.json());

async function runToolCall(call) {
  const res = await fetch("https://api.metagraph.sh/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: call.function.name,
        arguments: JSON.parse(call.function.arguments),
      },
    }),
  }).then((r) => r.json());
  return res.result?.structuredContent ?? res.result?.content?.[0]?.text;
}

// Pass `tools` to chat.completions.create({ model, messages, tools });
// when the model emits tool_calls, map each through runToolCall and return the
// result as a tool message.
```

### Anthropic (Messages)

```js
const tools = await fetch(
  "https://api.metagraph.sh/.well-known/agent-tools/anthropic.json",
).then((r) => r.json());

async function runToolUse(block) {
  const res = await fetch("https://api.metagraph.sh/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: block.name, arguments: block.input },
    }),
  }).then((r) => r.json());
  return res.result?.structuredContent ?? res.result?.content?.[0]?.text;
}

// Pass `tools` to messages.create({ model, messages, tools });
// for each tool_use block, return a tool_result with runToolUse(block).
```

## Source of truth

The specs derive from `listToolDefinitions()` in
[src/mcp-server.mjs](../src/mcp-server.mjs) via
[src/agent-tool-specs.mjs](../src/agent-tool-specs.mjs); `validate:mcp` asserts
the served specs cover every MCP tool and match the canonical projection. The
documents are advertised from the `/.well-known/api-catalog` linkset
(`describedby`) and the homepage discovery index.
