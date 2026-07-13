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
  Package,
  ArrowUpRight,
} from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import {
  PageHero,
  CopyButton,
  ExternalLink,
  McpToolsList,
  SectionHeading,
} from "@jsonbored/ui-kit";
import { AskBox } from "@/components/metagraphed/ask-box";
import { Skeleton } from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { agentResourcesQuery } from "@/lib/metagraphed/queries";
import { classNames } from "@/lib/metagraphed/format";
import type { AgentResources } from "@/lib/metagraphed/types";

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

// Icon + tone per resource kind. agent/skill lead (accent); the rest are neutral.
const KIND_META = {
  agent: { icon: Bot, tone: "text-accent" },
  skill: { icon: Sparkles, tone: "text-accent" },
  index: { icon: BookOpen, tone: "text-ink-muted" },
  // The catalog returns kind:'guide' (e.g. the agent integration guide). Give it
  // its own icon instead of falling through to the api fallback (Boxes).
  guide: { icon: BookOpen, tone: "text-ink-muted" },
  contract: { icon: FileCode2, tone: "text-ink-muted" },
  api: { icon: Boxes, tone: "text-ink-muted" },
  data: { icon: Database, tone: "text-ink-muted" },
} satisfies Record<string, { icon: typeof Bot; tone: string }>;

function kindMeta(kind: string) {
  return Object.hasOwn(KIND_META, kind) ? KIND_META[kind as keyof typeof KIND_META] : KIND_META.api;
}

// Typed SDKs (published + versioned on PyPI / npm) that wrap every route.
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

const QUICKSTART: { label: string; cmd: string }[] = [
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
        title="Use AI to explore Bittensor"
        description="Point any agent at metagraphed — over MCP, a typed SDK, or plain HTTP — and it can find, explain, and call the right Bittensor subnet for a task. No key, no account."
      />
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-[40rem] w-full" />}>
          <AgentsBody />
        </Suspense>
      </QueryErrorBoundary>
    </AppShell>
  );
}

function AgentsBody() {
  const { data } = useSuspenseQuery(agentResourcesQuery());
  const res = data.data as AgentResources;
  const mcp = res.mcp;

  return (
    <div className="mt-6 space-y-section">
      {/* MCP — the one primary path, given room of its own */}
      <section>
        <SectionHeading
          title="Connect over MCP"
          intro={`One command in Claude Code, Cursor, or any MCP client. ${mcp.tools.length} tools over ${mcp.transport} — search the registry, find a subnet for a task, get a callable RPC endpoint, ask a grounded question.`}
        />
        <div className="flex items-center gap-3 rounded-lg border border-accent/30 bg-accent-surface px-4 py-3.5">
          <Terminal className="size-4 shrink-0 text-accent" aria-hidden />
          <code className="flex-1 overflow-x-auto whitespace-nowrap font-mono text-[13px] text-ink-strong">
            {mcp.install}
          </code>
          <CopyButton value={mcp.install} label="MCP install command" />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px]">
          <ExternalLink href={mcp.endpoint} className="text-ink-muted hover:text-ink-strong">
            {mcp.endpoint.replace("https://", "")}
          </ExternalLink>
          <ExternalLink href={mcp.server_card} className="text-ink-muted hover:text-ink-strong">
            server card
          </ExternalLink>
        </div>
        <McpToolsList tools={mcp.tools} />
      </section>

      {/* Ask metagraphed directly — grounded Q&A over the registry */}
      <section>
        <SectionHeading
          title="Ask metagraphed"
          intro="Ask a question in plain English and get a grounded answer with citations back to the registry."
        />
        <AskBox />
      </section>

      {/* Two calmer alternatives, side by side */}
      <section className="grid gap-10 md:grid-cols-2">
        <div>
          <SectionHeading
            title="Or install the SDK"
            intro="Typed clients for Python and TypeScript that wrap every route and the RPC proxy."
          />
          <div className="space-y-2.5">
            {SDKS.map((sdk) => (
              <div
                key={sdk.lang}
                className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3"
              >
                <Package className="size-4 shrink-0 text-ink-muted" aria-hidden />
                <div className="min-w-0 flex-1">
                  <code className="block overflow-x-auto whitespace-nowrap font-mono text-[12px] text-ink-strong">
                    {sdk.install}
                  </code>
                  <ExternalLink href={sdk.url} className="font-mono text-[10px] text-ink-muted">
                    {sdk.lang} · {sdk.pkg}
                  </ExternalLink>
                </div>
                <CopyButton value={sdk.install} label={`${sdk.lang} install`} />
              </div>
            ))}
          </div>
        </div>

        <div>
          <SectionHeading title="Or drop into a chat" intro={res.copyable_agent.description} />
          <div className="flex flex-wrap gap-2">
            <a
              href={CLAUDE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/10 px-3.5 py-2 text-[13px] font-medium text-accent hover:bg-accent/15"
            >
              Open in Claude <ArrowUpRight className="size-3.5" />
            </a>
            <a
              href={CHATGPT_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3.5 py-2 text-[13px] font-medium text-ink-strong hover:border-ink/30"
            >
              Open in ChatGPT <ArrowUpRight className="size-3.5" />
            </a>
          </div>
          <p className="mt-3 font-mono text-[11px] text-ink-muted">
            system prompt{" "}
            <ExternalLink href={res.copyable_agent.url} className="text-ink-strong">
              {res.copyable_agent.url.replace("https://", "")}
            </ExternalLink>
          </p>
        </div>
      </section>

      {/* Every machine-readable surface — a calm list, not a card wall */}
      <section>
        <SectionHeading
          title="Everything else, fetchable directly"
          intro={`A paste-ready agent prompt, a Bittensor skill, llms.txt, the OpenAPI contract, grounded Q&A, semantic search, and bulk data — ${res.summary.callable_service_count} callable services across ${res.summary.subnet_count} subnets, all indexed at /api/v1/agent-resources.`}
        />
        <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {res.resources.map((r) => {
            const meta = kindMeta(r.kind);
            const Icon = meta.icon;
            return (
              <div key={r.id} className="flex items-center gap-3 px-4 py-3.5 hover:bg-card">
                <Icon className={classNames("size-4 shrink-0", meta.tone)} aria-hidden />
                <span className="flex-1 truncate text-[14px] text-ink-strong">{r.title}</span>
                <ExternalLink
                  href={r.url}
                  className="hidden shrink-0 font-mono text-[11px] text-ink-muted hover:text-ink-strong sm:inline"
                >
                  {r.url.replace("https://api.metagraph.sh", "")}
                </ExternalLink>
                <CopyButton value={r.url} label={`${r.title} URL`} />
              </div>
            );
          })}
        </div>
      </section>

      {/* Quickstart curls — no key, no account */}
      <section>
        <SectionHeading title="Try it" intro="No key, no account — hit any surface with curl." />
        <div className="space-y-2.5">
          {QUICKSTART.map((q) => (
            <div key={q.label} className="rounded-lg border border-border bg-card">
              <div className="flex items-center justify-between border-b border-border px-4 py-2">
                <span className="mg-label">{q.label}</span>
                <CopyButton value={q.cmd} label={q.label} />
              </div>
              <pre className="overflow-x-auto px-4 py-3 font-mono text-[11px] leading-relaxed text-ink">
                {q.cmd}
              </pre>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
