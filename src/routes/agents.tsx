import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense } from "react";
import {
  Bot,
  Terminal,
  FileCode2,
  Database,
  BookOpen,
  Sparkles,
  Boxes,
  ArrowUpRight,
} from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { PageHero } from "@/components/metagraphed/page-hero";
import { CopyButton } from "@/components/metagraphed/copy-button";
import { ExternalLink } from "@/components/metagraphed/external-link";
import { Skeleton } from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { agentResourcesQuery } from "@/lib/metagraphed/queries";
import { classNames } from "@/lib/metagraphed/format";
import type { AgentResources, AgentResource } from "@/lib/metagraphed/types";

export const Route = createFileRoute("/agents")({
  head: () => ({
    meta: [
      { title: "For AI agents — Metagraphed" },
      {
        name: "description",
        content:
          "Metagraphed is machine-readable end to end: MCP server, agent tool specs, llms.txt, grounded Q&A, semantic search, and bulk data over ~129 Bittensor subnets. Point your agent here.",
      },
      { property: "og:title", content: "For AI agents — Metagraphed" },
    ],
  }),
  component: AgentsPage,
});

// A pre-prompt that drops the live llms.txt + MCP into a fresh agent session.
const AGENT_PROMPT =
  "Use the metagraphed Bittensor registry. First read https://api.metagraph.sh/llms.txt for the available machine surfaces, then help me find and call the right Bittensor subnet for a task. It exposes an MCP server, an agent capability catalog, semantic search, and grounded Q&A over ~129 subnets.";
const CLAUDE_URL = `https://claude.ai/new?q=${encodeURIComponent(AGENT_PROMPT)}`;
const CHATGPT_URL = `https://chatgpt.com/?q=${encodeURIComponent(AGENT_PROMPT)}`;

const KIND_META: Record<string, { icon: typeof Bot; label: string; tone: string }> = {
  agent: { icon: Bot, label: "Agent", tone: "text-accent" },
  skill: { icon: Sparkles, label: "Skill", tone: "text-accent" },
  index: { icon: BookOpen, label: "Index", tone: "text-ink-strong" },
  contract: { icon: FileCode2, label: "Contract", tone: "text-ink-strong" },
  api: { icon: Boxes, label: "API", tone: "text-ink-strong" },
  data: { icon: Database, label: "Data", tone: "text-ink-strong" },
};

const QUICKSTART: { label: string; cmd: string }[] = [
  {
    label: "Ask a grounded question",
    cmd: `curl -s https://api.metagraph.sh/api/v1/ask \\
  -X POST -H 'content-type: application/json' \\
  -d '{"question":"which subnet does image generation?"}'`,
  },
  {
    label: "List every callable service",
    cmd: "curl -s https://api.metagraph.sh/api/v1/agent-catalog",
  },
  {
    label: "Semantic search the registry",
    cmd: "curl -s 'https://api.metagraph.sh/api/v1/search/semantic?q=video+generation'",
  },
];

function AgentsPage() {
  return (
    <AppShell>
      <PageHero
        eyebrow="For AI agents"
        live
        title="Built for agents to read"
        description="Metagraphed is machine-readable end to end — an MCP server, agent tool specs, llms.txt, grounded Q&A, semantic search, and bulk data over the Bittensor subnet registry. No SDK, no key, no account."
      />
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-[40rem] w-full" />}>
          <AgentsBody />
        </Suspense>
      </QueryErrorBoundary>
      <ApiSourceFooter paths={["/api/v1/agent-resources", "/mcp", "/llms.txt", "/agent.md"]} />
    </AppShell>
  );
}

function AgentsBody() {
  const { data } = useSuspenseQuery(agentResourcesQuery());
  const res = data.data as AgentResources;
  const mcp = res.mcp;
  const grouped = groupByKind(res.resources);

  return (
    <div className="space-y-10">
      {/* Connect-your-agent: the two paste-ready paths */}
      <section className="grid gap-4 lg:grid-cols-2">
        {/* MCP */}
        <div className="rounded-lg border border-accent/30 bg-gradient-to-br from-accent/[0.06] to-transparent p-5">
          <div className="flex items-center gap-2 text-accent">
            <Terminal className="size-4" aria-hidden />
            <h2 className="font-display text-sm font-semibold uppercase tracking-wider">
              Connect over MCP
            </h2>
          </div>
          <p className="mt-1 text-[13px] text-ink-muted">
            {mcp.tools.length} tools over {mcp.transport}. One command in Claude Code, Cursor, or
            any MCP client:
          </p>
          <div className="mt-3 flex items-center gap-2 rounded border border-border bg-card px-3 py-2">
            <code className="flex-1 overflow-x-auto whitespace-nowrap font-mono text-[12px] text-ink-strong">
              {mcp.install}
            </code>
            <CopyButton value={mcp.install} label="MCP install command" />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-ink-muted">
            <span>
              endpoint{" "}
              <ExternalLink href={mcp.endpoint} className="text-ink-strong">
                {mcp.endpoint.replace("https://", "")}
              </ExternalLink>
            </span>
            <ExternalLink href={mcp.server_card}>server card</ExternalLink>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {mcp.tools.map((t) => (
              <span
                key={t.name}
                title={t.title}
                className="rounded border border-border bg-paper px-1.5 py-0.5 font-mono text-[10px] text-ink-muted"
              >
                {t.name}
              </span>
            ))}
          </div>
        </div>

        {/* Drop-in prompt */}
        <div className="rounded-lg border border-border bg-card p-5">
          <div className="flex items-center gap-2 text-ink-strong">
            <Bot className="size-4 text-accent" aria-hidden />
            <h2 className="font-display text-sm font-semibold uppercase tracking-wider">
              Drop into a chat agent
            </h2>
          </div>
          <p className="mt-1 text-[13px] text-ink-muted">{res.copyable_agent.description}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <a
              href={CLAUDE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded border border-accent/40 bg-accent/10 px-3 py-1.5 text-[12px] font-medium text-accent hover:bg-accent/15"
            >
              Open in Claude <ArrowUpRight className="size-3" />
            </a>
            <a
              href={CHATGPT_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded border border-border bg-paper px-3 py-1.5 text-[12px] font-medium text-ink-strong hover:border-ink/30"
            >
              Open in ChatGPT <ArrowUpRight className="size-3" />
            </a>
          </div>
          <div className="mt-3 flex items-center gap-2 rounded border border-border bg-paper px-3 py-2">
            <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
              system prompt
            </span>
            <ExternalLink
              href={res.copyable_agent.url}
              className="flex-1 truncate font-mono text-[12px] text-ink-strong"
            >
              {res.copyable_agent.url.replace("https://", "")}
            </ExternalLink>
            <CopyButton value={res.copyable_agent.url} label="agent prompt URL" />
          </div>
          <p className="mt-2 font-mono text-[10px] text-ink-muted">
            {res.summary.callable_service_count} callable services · {res.summary.subnet_count}{" "}
            subnets indexed
          </p>
        </div>
      </section>

      {/* Every machine-readable surface */}
      <section>
        <h2 className="mb-2 font-display text-sm font-semibold uppercase tracking-wider text-ink-strong">
          Machine-readable surfaces
        </h2>
        <p className="mb-3 text-[13px] text-ink-muted">
          Everything an agent needs, fetchable directly — discoverable at{" "}
          <ExternalLink href="https://api.metagraph.sh/api/v1/agent-resources">
            /api/v1/agent-resources
          </ExternalLink>{" "}
          and the <code className="font-mono text-[12px]">/.well-known/</code> tree.
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {grouped.map(({ kind, items }) =>
            items.map((r) => {
              const meta = KIND_META[r.kind] ?? KIND_META.api;
              const Icon = meta.icon;
              return (
                <div key={r.id} className="flex flex-col rounded border border-border bg-card p-3">
                  <div className="flex items-start gap-2">
                    <Icon className={classNames("mt-0.5 size-4 shrink-0", meta.tone)} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[9px] uppercase tracking-widest text-ink-muted">
                          {kind}
                        </span>
                      </div>
                      <p className="text-[13px] font-medium text-ink-strong">{r.title}</p>
                    </div>
                  </div>
                  <div className="mt-2 flex items-center gap-1.5">
                    <ExternalLink
                      href={r.url}
                      className="flex-1 truncate font-mono text-[11px] text-ink-muted"
                    >
                      {r.url.replace("https://api.metagraph.sh", "")}
                    </ExternalLink>
                    <CopyButton value={r.url} label={`${r.title} URL`} />
                  </div>
                </div>
              );
            }),
          )}
        </div>
      </section>

      {/* Quickstart curls */}
      <section>
        <h2 className="mb-2 font-display text-sm font-semibold uppercase tracking-wider text-ink-strong">
          Try it
        </h2>
        <div className="space-y-2">
          {QUICKSTART.map((q) => (
            <div key={q.label} className="rounded border border-border bg-paper">
              <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
                <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                  {q.label}
                </span>
                <CopyButton value={q.cmd} label={q.label} />
              </div>
              <pre className="overflow-x-auto px-3 py-2 font-mono text-[11px] leading-relaxed text-ink">
                {q.cmd}
              </pre>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

// Stable kind ordering for the surfaces grid (agent/skill first, data last).
const KIND_ORDER = ["agent", "skill", "index", "contract", "api", "data"];
function groupByKind(resources: AgentResource[]) {
  const byKind = new Map<string, AgentResource[]>();
  for (const r of resources) {
    const list = byKind.get(r.kind) ?? [];
    list.push(r);
    byKind.set(r.kind, list);
  }
  return [...byKind.keys()]
    .sort((a, b) => {
      const ai = KIND_ORDER.indexOf(a);
      const bi = KIND_ORDER.indexOf(b);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    })
    .map((kind) => ({
      kind: KIND_META[kind]?.label ?? kind,
      items: byKind.get(kind)!,
    }));
}
