import { Package, Sparkles, ArrowUpRight, type LucideIcon } from "lucide-react";
import { CopyButton, ExternalLink, McpToolsList, ClaudeIcon, OpenAIIcon } from "@jsonbored/ui-kit";
import { Panel } from "@/components/metagraphed/primitives";
import { AgentHarnessPicker } from "@/components/metagraphed/agent-harness-picker";
import { classNames } from "@/lib/metagraphed/format";
import { CLAUDE_URL, CHATGPT_URL } from "@/lib/metagraphed/agent-prompt";
import type { AgentResource, AgentResources } from "@/lib/metagraphed/types";

const SDKS: { lang: string; pkg: string; install: string; url: string }[] = [
  {
    lang: "Python",
    pkg: "metagraphed",
    install: "pip install metagraphed",
    url: "https://pypi.org/project/metagraphed/",
  },
  {
    lang: "TypeScript",
    pkg: "@jsonbored/metagraphed",
    install: "npm i @jsonbored/metagraphed",
    url: "https://www.npmjs.com/package/@jsonbored/metagraphed",
  },
];

function InstallRow({
  icon: Icon,
  iconTone = "text-ink-muted",
  command,
  meta,
  metaHref,
  copyLabel,
}: {
  icon: LucideIcon;
  iconTone?: string;
  command: string;
  meta: string;
  metaHref?: string;
  copyLabel: string;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <Icon className={classNames("size-4 shrink-0", iconTone)} aria-hidden />
      <div className="min-w-0 flex-1">
        <code className="block overflow-x-auto whitespace-nowrap font-mono mg-type-caption text-ink-strong">
          {command}
        </code>
        {metaHref ? (
          <ExternalLink href={metaHref} className="mg-type-data-sm text-ink-muted">
            {meta}
          </ExternalLink>
        ) : (
          <span className="mg-type-data-sm text-ink-muted">{meta}</span>
        )}
      </div>
      <CopyButton value={command} label={copyLabel} compact />
    </div>
  );
}

/**
 * Step 2 of /agents: every way to wire a client up to metagraphed, in one
 * card instead of three co-equal "Or install the SDK" / "Or add the skill" /
 * "Or drop into a chat" sections fighting for the same visual weight. MCP
 * leads because it is the one path that needs no install step in the
 * consuming project — the rest are alternates for hosts that can't do MCP.
 */
export function AgentConnectCard({
  mcp,
  skillResource,
  copyableAgentDescription,
}: {
  mcp: AgentResources["mcp"];
  skillResource: (AgentResource & { install: string }) | undefined;
  copyableAgentDescription: string;
}) {
  return (
    <Panel flush>
      <div className="border-b border-border/70 p-4 md:p-6">
        <AgentHarnessPicker mcp={mcp} />
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 mg-type-data">
          <ExternalLink href={mcp.endpoint} className="text-ink-muted hover:text-ink-strong">
            {mcp.endpoint.replace("https://", "")}
          </ExternalLink>
          <ExternalLink href={mcp.server_card} className="text-ink-muted hover:text-ink-strong">
            server card
          </ExternalLink>
          <span className="text-ink-subtle-text">
            {mcp.tools.length} tools over {mcp.transport}
          </span>
        </div>
        <McpToolsList tools={mcp.tools} />
      </div>

      <div className="divide-y divide-border">
        {SDKS.map((sdk) => (
          <InstallRow
            key={sdk.lang}
            icon={Package}
            command={sdk.install}
            meta={`${sdk.lang} · ${sdk.pkg}`}
            metaHref={sdk.url}
            copyLabel={`${sdk.lang} install`}
          />
        ))}
        {skillResource ? (
          <InstallRow
            icon={Sparkles}
            iconTone="text-accent"
            command={skillResource.install}
            meta={skillResource.title}
            metaHref={skillResource.url}
            copyLabel="Skill install command"
          />
        ) : null}
      </div>

      <div className="border-t border-border/70 p-4 md:p-6">
        <p className="mg-type-caption text-ink-muted">{copyableAgentDescription}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <ExternalLink
            bare
            href={CLAUDE_URL}
            className="inline-flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent/10 px-3.5 py-2 mg-type-caption-lg font-medium text-accent hover:bg-accent/15"
          >
            <ClaudeIcon className="size-3.5" aria-hidden /> Open in Claude{" "}
            <ArrowUpRight className="size-3.5" />
          </ExternalLink>
          <ExternalLink
            bare
            href={CHATGPT_URL}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3.5 py-2 mg-type-caption-lg font-medium text-ink-strong hover:border-ink/30"
          >
            <OpenAIIcon className="size-3.5" aria-hidden /> Open in ChatGPT{" "}
            <ArrowUpRight className="size-3.5" />
          </ExternalLink>
        </div>
      </div>
    </Panel>
  );
}
