import { useSuspenseQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { ActionBar, ShareButton, SectionHeading } from "@jsonbored/ui-kit";
import { AsyncPanel, PageMasthead } from "@/components/metagraphed/primitives";
import { AgentContextCard } from "@/components/metagraphed/agent-context-card";
import { AgentConnectCard } from "@/components/metagraphed/agent-connect-card";
import { AgentLiveCard } from "@/components/metagraphed/agent-live-card";
import { FirstPromptWalkthrough } from "@/components/metagraphed/first-prompt-walkthrough";
import { AgentResourceGrid } from "@/components/metagraphed/agent-resource-grid";
import { AgentPlaybookGrid } from "@/components/metagraphed/agent-playbook-grid";
import { Skeleton } from "@/components/metagraphed/states";
import { agentResourcesQuery } from "@/lib/metagraphed/queries";
import type { AgentResource, AgentResources } from "@/lib/metagraphed/types";

export function AgentsPage() {
  return (
    <AppShell>
      <PageMasthead
        eyebrow="For AI agents"
        title="Use AI to explore Bittensor"
        description="Point any agent at metagraphed — over MCP, a typed SDK, or plain HTTP — and it can find, explain, and call the right Bittensor subnet for a task. No key, no account."
        actions={
          <ActionBar>
            <ShareButton bare />
          </ActionBar>
        }
      />
      <AsyncPanel
        context="agent resources"
        fallback={<Skeleton className="h-[40rem] w-full" />}
        retryQueryKeys={[agentResourcesQuery().queryKey]}
      >
        <AgentsBody />
      </AsyncPanel>
      <ApiSourceFooter paths={["/api/v1/agent-resources"]} />
    </AppShell>
  );
}

/** The masthead's numbers, said once and out loud instead of buried mid-paragraph. */
function StatRail({ res }: { res: AgentResources }) {
  const stats: { label: string; value: string }[] = [
    { label: "Subnets covered", value: res.summary.subnet_count.toLocaleString() },
    { label: "Callable services", value: res.summary.callable_service_count.toLocaleString() },
    { label: "MCP tools", value: res.mcp.tools.length.toLocaleString() },
  ];
  return (
    <div className="flex flex-wrap gap-x-8 gap-y-3 border-b border-border pb-6">
      {stats.map((s) => (
        <div key={s.label} className="min-w-0">
          <div className="font-display text-xl font-semibold tabular-nums text-ink-strong md:text-2xl">
            {s.value}
          </div>
          <div className="mt-0.5 mg-type-caption text-ink-muted">{s.label}</div>
        </div>
      ))}
    </div>
  );
}

function AgentsBody() {
  const { data } = useSuspenseQuery(agentResourcesQuery());
  const res = data.data as AgentResources;
  const skillResource = res.resources.find(
    (r): r is AgentResource & { install: string } => r.kind === "skill" && Boolean(r.install),
  );

  return (
    <div className="mt-6 space-y-section">
      <StatRail res={res} />

      <section>
        <SectionHeading
          step={1}
          title="Hand off context"
          intro="Copy once, ingest once — everything an agent needs to start using metagraphed on its own."
        />
        <AgentContextCard agent={res.copyable_agent} />
      </section>

      <section id="connect">
        <SectionHeading
          step={2}
          title="Connect your client"
          intro="MCP is the fastest path — no install in the consuming project. The SDK, skill, and chat links below are alternates for hosts that can't speak MCP."
        />
        <AgentConnectCard
          mcp={res.mcp}
          skillResource={skillResource}
          copyableAgentDescription={res.copyable_agent.description}
        />
      </section>

      <section>
        <SectionHeading step={3} title="Query the registry live" />
        <AgentLiveCard />
      </section>

      <section id="first-prompt">
        <SectionHeading
          step={4}
          title="Try your first prompt"
          intro="Paste one straight into the client you just connected — each one is a real task, not a demo."
        />
        <FirstPromptWalkthrough />
      </section>

      <section>
        <SectionHeading
          step={5}
          title="Deeper integrations"
          intro="Context files, the OpenAPI contract, GraphQL, bulk data, and everything else the registry exposes directly."
        />
        <AgentResourceGrid resources={res.resources} />
      </section>

      <section id="playbooks">
        <SectionHeading
          step={6}
          title="Task-oriented playbooks"
          intro="Executed, tested tool-call sequences for the tasks people actually bring — also registered as MCP prompts for harnesses that surface them natively."
        />
        <AgentPlaybookGrid />
      </section>
    </div>
  );
}
