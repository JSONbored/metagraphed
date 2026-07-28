// #8382: the harness picker's single data structure -- every one of the five
// generated configs derives from ONE input (the live MCP endpoint/transport
// this app already fetches via agentResourcesQuery()'s `mcp` field), so a URL
// change updates all five automatically, per the issue's own requirement.
//
// Claude Code's command is NOT generated here -- it's `mcp.install` from the
// live API (the backend already maintains the exact, verified CLI syntax);
// this module only builds the four configs the API doesn't already provide.
// Claude Desktop's and Cursor's JSON shapes are each vendor's own currently-
// documented remote-MCP config format, not something this repo controls --
// if either vendor's schema changes, this is the one place to update it.

export type HarnessId = "claude-code" | "claude-desktop" | "chatgpt" | "cursor" | "generic-mcp";

export interface Harness {
  id: HarnessId;
  label: string;
  /** Short, factual description of what's about to happen -- no marketing copy. */
  blurb: string;
}

export const HARNESSES: readonly Harness[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    blurb: "One CLI command, no config file to hand-edit.",
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    blurb: "Add a remote MCP server entry to your config file.",
  },
  {
    id: "cursor",
    label: "Cursor",
    blurb: "Add a remote MCP server entry to .cursor/mcp.json.",
  },
  {
    id: "chatgpt",
    label: "ChatGPT",
    blurb: "Connector support varies by plan and is still rolling out.",
  },
  {
    id: "generic-mcp",
    label: "Other MCP client",
    blurb: "Any client that speaks streamable-HTTP MCP can connect directly.",
  },
] as const;

export interface McpConnectionInfo {
  endpoint: string;
  install: string;
  transport: string;
}

export type HarnessConfigKind = "command" | "json" | "steps";

export interface HarnessConfig {
  kind: HarnessConfigKind;
  /** What CopyableCode's label prop (or a heading, for "steps") should say. */
  label: string;
  /** The copy-ready command or JSON block; omitted for "steps". */
  content?: string;
  /** Numbered instructions; only set for harnesses with no single copy-paste artifact. */
  steps?: string[];
}

function claudeDesktopConfig(mcp: McpConnectionInfo): string {
  return JSON.stringify(
    {
      mcpServers: {
        metagraphed: {
          transport: { type: "http", url: mcp.endpoint },
        },
      },
    },
    null,
    2,
  );
}

function cursorConfig(mcp: McpConnectionInfo): string {
  return JSON.stringify(
    {
      mcpServers: {
        metagraphed: { url: mcp.endpoint },
      },
    },
    null,
    2,
  );
}

/**
 * Builds the copy-ready config for one harness, or the step list for a
 * harness with no single artifact to copy. Every branch reads only `mcp`
 * (endpoint/install/transport) -- no hardcoded URL anywhere in this file.
 */
export function buildHarnessConfig(harness: HarnessId, mcp: McpConnectionInfo): HarnessConfig {
  switch (harness) {
    case "claude-code":
      return { kind: "command", label: "Terminal command", content: mcp.install };
    case "claude-desktop":
      return {
        kind: "json",
        label: "claude_desktop_config.json",
        content: claudeDesktopConfig(mcp),
      };
    case "cursor":
      return { kind: "json", label: ".cursor/mcp.json", content: cursorConfig(mcp) };
    case "chatgpt":
      return {
        kind: "steps",
        label: "ChatGPT",
        steps: [
          "Remote MCP connector support is rolling out gradually and varies by ChatGPT plan -- check platform.openai.com's current connector docs for the exact steps on your account.",
          `If your plan supports it, add a connector pointing at ${mcp.endpoint} (${mcp.transport}).`,
          "No connector support yet? Open a chat pre-filled with a prompt describing the registry instead (the 'Open in ChatGPT' link elsewhere on this page).",
        ],
      };
    case "generic-mcp":
      return {
        kind: "steps",
        label: "Other MCP client",
        steps: [
          `Point any MCP client that supports ${mcp.transport} directly at ${mcp.endpoint} -- no install, no key.`,
        ],
      };
  }
}
