# Getting started with MCP Analytics - Docs

**MCP Analytics is in beta**

`@posthog/mcp` is published as a `0.1.x` release on npm. We're building it in public – the event shape, options, and tracing behavior may still change before `1.0`. Pin a specific version and don't depend on it for production reporting yet.

## Add @posthog/mcp to your MCP server

MCP Analytics gives you visibility into how AI agents actually use the MCP server you ship. With one wrapper call you can track:

- 🛠️ Every tool call (parameters, response, duration, errors)
- 🎯 Agent intent – the _why_ behind each call, not just the _what_
- 🧭 Every `tools/list` so you can compare advertised vs called
- 🪪 The MCP client name and version
- 🧵 The full session, end to end
- 🚧 Capabilities the agent wished existed (with `reportMissing`)

The SDK supports any TypeScript MCP server built on `@modelcontextprotocol/sdk`. The fastest way to get set up is our wizard, which installs the package and wires up `instrument()` for you (it also works for [LLM coding agents](/blog/envoy-wizard-llm-agent.md) like Cursor and Bolt):

`npx @posthog/wizard mcp-analytics`

[Learn more](/wizard.md)

Prefer to do it by hand? Install it from npm and call `instrument()` once at startup. You pass your `posthog-node` client as the required second argument:

Terminal

PostHog AI

```bash
npm install @posthog/mcp posthog-node
```

TypeScript

PostHog AI

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { PostHog } from "posthog-node";
import { instrument } from "@posthog/mcp";
const server = new Server({ name: "my-mcp-server", version: "1.0.0" });
const posthog = new PostHog(process.env.POSTHOG_PROJECT_API_KEY, {
  host: "https://us.i.posthog.com",
});
instrument(server, posthog);
```

[Full installation guide](/docs/mcp-analytics/installation.md)

## See your first events

Run your MCP server and connect an agent to it (Claude Desktop, Cursor, Codex, or your own). Within seconds of the first tool call, PostHog will receive `$mcp_tool_call`, `$mcp_tools_list`, and `$mcp_initialize` events – all prefixed with `$mcp_*` so they never collide with anything else in your project.

Open the [activity feed](https://us.posthog.com/project/2/activity) and filter for `event = $mcp_tool_call`. You should see one row per agent tool invocation, each with `$mcp_tool_name`, `$mcp_parameters`, `$mcp_response`, `$mcp_duration_ms`, and `$mcp_is_error`.

![PostHog activity feed filtered to $mcp_tool_call events, with tool name, client, error state, and duration columns](https://res.cloudinary.com/dmukukwp6/image/upload/q_auto,f_auto/mcp_activity_feed_dark_e795d95547.png)

[See every event the SDK emits](/docs/mcp-analytics/events.md)

## Capture what the agent was trying to do

The single most useful signal in MCP Analytics is **intent**: the user goal that led the agent to call this tool. The SDK injects a required `context` argument into every tool's schema and captures it as `$mcp_intent`. Your tool implementation never sees it.

TypeScript

PostHog AI

```typescript
instrument(server, posthog, {
  context: {
    description:
      "Describe the user's underlying goal in one sentence — not the tool you're calling.",
  },
});
```

For agents that ignore the schema hint (raw cURL clients, schema-blind crawlers), supply an `intentFallback`. The SDK calls it whenever no `context` argument was passed:

TypeScript

PostHog AI

```typescript
instrument(server, posthog, {
  intentFallback: (request) => {
    const tool = request.params?.name;
    return tool ? `Invoking ${tool}` : null;
  },
});
```

[Learn about intent capture](/docs/mcp-analytics/intent.md)

## Build your first dashboard

Every event is a normal PostHog event, so insights, dashboards, alerts, and SQL all work without further setup – and the [MCP Analytics view](/docs/mcp-analytics.md) (in beta – [enable the feature preview](https://app.posthog.com/settings/user-feature-previews#mcp-analytics)) gives you the most useful cuts out of the box. The four queries we suggest building (or reading straight from the dashboard) first:

- ### Top tools per server

  Where is your agent traffic concentrated? Which tools earn their keep?

- ### Error rate per tool

  Which tools throw most often? Pair with `$exception` events to triage.

- ### Intent samples by source

  How much of your traffic supplies explicit context vs falls back to `intentFallback`?

- ### Advertised tools that never get called

  Find dead surface area by joining `$mcp_tools_list` against `$mcp_tool_call`.

The tool quality tab surfaces error rate and latency percentiles per tool, with a row to drill into for any single tool:

![MCP Analytics tool quality tab showing calls and errors, success rate, latency percentiles, and a per-tool table](https://res.cloudinary.com/dmukukwp6/image/upload/q_auto,f_auto/mcp_tool_quality_light_f91f27f6e1.png)![MCP Analytics tool quality tab showing calls and errors, success rate, latency percentiles, and a per-tool table](https://res.cloudinary.com/dmukukwp6/image/upload/q_auto,f_auto/mcp_tool_quality_dark_add2659eaa.png)

[Copy-paste queries](/docs/mcp-analytics/queries.md)

## Identify the user behind the agent

By default each event is attributed to the MCP connection's session ID. To attribute calls to a real user – for per-user retention, group analytics, and person properties – wire an `identify` callback:

TypeScript

PostHog AI

```typescript
instrument(server, posthog, {
  identify: async (request, extra) => {
    const token = extra?.requestInfo?.headers?.authorization;
    const user = token ? await resolveUserFromToken(token) : null;
    return user
      ? { distinctId: user.id, properties: { name: user.name } }
      : null;
  },
});
```

The SDK emits a `$identify` event the first time it sees a new identity for a session, and PostHog's standard merge takes care of attributing prior anonymous activity.

[Identify users](/docs/mcp-analytics/identifying-users.md)

## Find capability gaps with \`reportMissing\`

The most actionable signal for an MCP server owner is _the agent wanted to do something I don't support_. Enable `reportMissing: true` and the SDK registers a `get_more_tools` virtual tool. When the agent invokes it, you get a queryable feed of unmet asks – straight into your roadmap.

TypeScript

PostHog AI

```typescript
instrument(server, posthog, {
  reportMissing: true,
});
```

SQL

[Run in PostHog](https://us.posthog.com/sql?open_query=SELECT%0A++properties.%24mcp_intent+++++++AS+unmet_request%2C%0A++properties.%24mcp_client_name++AS+client%2C%0A++count%28%29++++++++++++++++++++++AS+times_asked%0AFROM+events%0AWHERE+event+%3D+'%24mcp_missing_capability'%0A++AND+timestamp+%3E+now%28%29+-+INTERVAL+30+DAY%0AGROUP+BY+unmet_request%2C+client%0AORDER+BY+times_asked+DESC)

PostHog AI

```sql
SELECT
  properties.$mcp_intent       AS unmet_request,
  properties.$mcp_client_name  AS client,
  count()                      AS times_asked
FROM events
WHERE event = '$mcp_missing_capability'
  AND timestamp > now() - INTERVAL 30 DAY
GROUP BY unmet_request, client
ORDER BY times_asked DESC
```

[Track missing capabilities](/docs/mcp-analytics/missing-capability.md)

## Ship safely

The SDK runs every event through automatic sanitization (image/audio/binary stubs, sensitive-key masking like `authorization`, `cookie`, `password`, PostHog key patterns) and truncation to fit ingestion limits. For full control, add a `beforeSend` hook that runs on each built PostHog payload right before it's sent – mutate and return the event to send it, or return a nullish value to drop it.

TypeScript

PostHog AI

```typescript
instrument(server, posthog, {
  beforeSend: (event) => {
    if (event.event === "$exception") return null; // drop exceptions
    return event;
  },
});
```

[Privacy & redaction](/docs/mcp-analytics/privacy.md)

---

That's it. You're ready to ship `@posthog/mcp` to production agents – within the beta caveats above.

[Install MCP Analytics](/docs/mcp-analytics/installation.md)

1/7

[**Add @posthog/mcp to your MCP server** _**Required**_](#quest-item-add-posthogmcp-to-your-mcp-server)[**See your first events** _**Required**_](#quest-item-see-your-first-events)[**Capture what the agent was trying to do** _**Recommended**_](#quest-item-capture-what-the-agent-was-trying-to-do)[**Build your first dashboard** _**Recommended**_](#quest-item-build-your-first-dashboard)[**Identify the user behind the agent** _**Recommended**_](#quest-item-identify-the-user-behind-the-agent)[**Find capability gaps with \`reportMissing\`** _**Recommended**_](#quest-item-find-capability-gaps-with-reportmissing)[**Ship safely** _**Required**_](#quest-item-ship-safely)

**Add @posthog/mcp to your MCP server**

_**Required**_

### Community questions

Ask a question

### Was this page useful?

HelpfulCould be better
