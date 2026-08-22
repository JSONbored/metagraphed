import { useSuspenseQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { ShareButton, SectionHead, EntityHero, FactSentence } from "@jsonbored/ui-kit";
import { AsyncPanel } from "@/components/metagraphed/primitives";
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
      <EntityHero
        name="Use AI to explore Bittensor"
        action={
          <div className="mg-actions">
            <ShareButton bare />
          </div>
        }
        sentence={
          <FactSentence>
            Point any agent at metagraphed — over MCP, a typed SDK, or plain HTTP — and it can find,
            explain, and call the right Bittensor subnet for a task. No key, no account.
          </FactSentence>
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
    { label: "Subnets covered", value: res.summary.subnet_count.toLocaleString("en-US") },
    {
      label: "Callable services",
      value: res.summary.callable_service_count.toLocaleString("en-US"),
    },
    { label: "MCP tools", value: res.mcp.tools.length.toLocaleString("en-US") },
  ];
  return (
    <div className="flex flex-wrap gap-x-8 gap-y-3 border-b border-border pb-6">
      {stats.map((s) => (
        <div key={s.label} className="min-w-0">
          <div className="font-display text-28 font-semibold tabular-nums text-ink-strong md:text-28">
            {s.value}
          </div>
          <div className="mt-0.5 text-13 text-ink-muted">{s.label}</div>
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
        <SectionHead
          name="Hand off context"
          question="Copy once, ingest once — everything an agent needs to start using metagraphed on its own."
        />
        <AgentContextCard agent={res.copyable_agent} />
      </section>

      <section id="connect">
        <SectionHead
          name="Connect your client"
          question="MCP is the fastest path — no install in the consuming project. The SDK, skill, and chat links below are alternates for hosts that can't speak MCP."
        />
        <AgentConnectCard
          mcp={res.mcp}
          skillResource={skillResource}
          copyableAgentDescription={res.copyable_agent.description}
        />
      </section>

      <section>
        <SectionHead name="Query the registry live" />
        <AgentLiveCard />
      </section>

      <section id="first-prompt">
        <SectionHead
          name="Try your first prompt"
          question="Paste one straight into the client you just connected — each one is a real task, not a demo."
        />
        <FirstPromptWalkthrough />
      </section>

      <section>
        <SectionHead
          name="Deeper integrations"
          question="Context files, the OpenAPI contract, GraphQL, bulk data, and everything else the registry exposes directly."
        />
        <AgentResourceGrid resources={res.resources} />
      </section>

      <section id="playbooks">
        <SectionHead
          name="Task-oriented playbooks"
          question="Executed, tested tool-call sequences for the tasks people actually bring — also registered as MCP prompts for harnesses that surface them natively."
        />
        <AgentPlaybookGrid />
      </section>
    </div>
  );
}
