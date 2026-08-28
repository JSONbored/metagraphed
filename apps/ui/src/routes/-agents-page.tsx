import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AnalyticsSection,
  CopyableCode,
  DataTable,
  EntityHero,
  FactSentence,
  FilterField,
  FilterSelect,
  RangeControl,
  Raw,
  Skeleton,
  type DataTableColumn,
  type FactCells,
  type RawRow,
} from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { factCells } from "@/lib/metagraphed/facts";
import { RouterLink } from "@/components/metagraphed/router-link";
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import { API_BASE } from "@/lib/metagraphed/config";
import { formatNumber } from "@/lib/metagraphed/format";
import { agentResourcesQuery } from "@/lib/metagraphed/queries";
import { ErrorState } from "@/components/metagraphed/states";
import {
  agentFacts,
  connectSnippets,
  facet,
  filterTools,
  toolRows,
  type ToolRow,
} from "@/components/metagraphed/builder/builder-logic";

const API_PATHS = ["/api/v1/agent-resources"];

function ApiSources() {
  useRegisterApiSource(API_PATHS);
  return null;
}

/** Preserve the connection panel's working geometry while its server card arrives. */
function AgentConnectionSkeleton() {
  return (
    <div className="mg-agent-connection" aria-busy="true">
      <span className="sr-only">Loading MCP connection</span>
      <div className="mg-agent-connection-head">
        <div className="mg-agent-connection-identity">
          <span className="mg-agent-connection-stamp" aria-hidden="true">
            <span>MCP</span>
            <span>/core</span>
          </span>
          <div>
            <p className="mg-agent-connection-eyebrow">Metagraphed MCP · Bittensor in a box</p>
            <p className="mg-agent-connection-title">Loading connection details</p>
          </div>
        </div>
        <Skeleton className="h-8 w-56 max-w-full" />
      </div>
      <Skeleton className="min-h-12 w-full" />
      <div className="mg-agent-connection-meta" aria-hidden="true">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-32" />
      </div>
    </div>
  );
}

/**
 * Agents (#11626) — two sections.
 *
 * It was 29 sections, 44 paragraphs and 1,448 words explaining how to point an
 * agent at a server whose whole interface is one command. It is that command,
 * and the list of what the command gets you.
 *
 * The numbered `01 HAND OFF CONTEXT` headings, the context-bundle panel and
 * every prose section are gone; the bundle is a `Raw` row, which is where a
 * copyable artifact belongs.
 */
export function AgentsPage() {
  const [harness, setHarness] = useState("claude");
  const [q, setQ] = useState("");
  const [family, setFamily] = useState("");
  const resources = useQuery({ ...agentResourcesQuery(), retry: 0 });

  const payload = resources.data?.data as Record<string, unknown> | undefined;
  const mcp = payload?.mcp as
    | {
        install?: string;
        core_endpoint?: string;
        endpoint?: string;
        recommended_endpoint?: string;
        server_card?: string;
        transport?: string;
        tools?: Record<string, unknown>[];
      }
    | undefined;
  const tools = useMemo(() => toolRows(mcp?.tools), [mcp]);
  const families = useMemo(() => facet(tools, (row) => row.family), [tools]);
  const shown = useMemo(() => filterTools(tools, q, family), [tools, q, family]);
  const snippets = useMemo(() => connectSnippets(mcp), [mcp]);
  const snippet = snippets.find((item) => item.value === harness) ?? snippets[0];
  const transport =
    mcp?.transport === "streamable-http"
      ? "Streamable HTTP"
      : mcp?.transport
        ? mcp.transport.replaceAll("-", " ")
        : null;
  const hasCoreEndpoint = Boolean(mcp?.recommended_endpoint ?? mcp?.core_endpoint);
  const heroCells: FactCells | undefined = resources.isPending
    ? [
        { label: "MCP tools", value: "—", loading: true },
        { label: "Application subnets covered", value: "—", loading: true },
        { label: "Callable services", value: "—", loading: true },
      ]
    : (factCells(
        agentFacts(payload?.summary as Parameters<typeof agentFacts>[0], tools.length, {
          count: formatNumber,
        }),
      ) ?? undefined);

  const columns: DataTableColumn<ToolRow>[] = [
    { key: "name", label: "Tool", kind: "identifier", width: 280, value: (row) => row.name },
    { key: "family", label: "Family", kind: "status", width: 160, value: (row) => row.family },
    { key: "title", label: "What it answers", value: (row) => row.title },
  ];

  const resourceRows = Array.isArray(payload?.resources)
    ? (payload.resources as Record<string, unknown>[])
    : [];
  const rawRows: RawRow[] = [
    ...(mcp?.core_endpoint
      ? [{ label: "mcp (core)", value: mcp.core_endpoint, href: mcp.core_endpoint }]
      : []),
    ...(mcp?.endpoint
      ? [{ label: "mcp (all tools)", value: mcp.endpoint, href: mcp.endpoint }]
      : []),
    ...(mcp?.server_card
      ? [{ label: "server card", value: mcp.server_card, href: mcp.server_card }]
      : []),
    ...resourceRows.flatMap((resource) => {
      const url = typeof resource.url === "string" ? resource.url : null;
      const title = typeof resource.title === "string" ? resource.title : null;
      return url && title ? [{ label: title.toLowerCase(), value: url, href: url }] : [];
    }),
    ...API_PATHS.map((path) => ({
      label: path.replace("/api/v1/", ""),
      value: `${API_BASE}${path}`,
      href: `${API_BASE}${path}`,
    })),
  ];

  return (
    <AppShell>
      <ApiSources />
      <EntityHero
        className="mg-hero--entity mg-hero--mcp"
        name="MCP"
        action={
          <RouterLink href="/docs/mcp" className="mg-hero-action">
            Read the MCP docs
          </RouterLink>
        }
        sentence={
          <FactSentence>
            One command points any MCP client at every Bittensor subnet this registry knows.
          </FactSentence>
        }
        // A STRIP, not chips (#11696). This page's subject is a table, and its
        // headline counts were 11px `Fact` chips inside the sentence -- set
        // smaller than the rows they frame. The lede stays prose.
        cells={heroCells}
        live={{
          updatedAt: (payload?.generated_at as string | undefined) ?? null,
          source: "server card",
          onRefresh: () => void resources.refetch(),
          refreshing: resources.isFetching,
        }}
      />

      <AnalyticsSection
        className="mg-agents-connect"
        id="connect"
        name="Connect"
        question="One line to point an agent here."
        visual={
          resources.isPending ? (
            <AgentConnectionSkeleton />
          ) : resources.isError ? (
            <ErrorState
              error={resources.error}
              context="MCP connection details"
              onRetry={() => void resources.refetch()}
            />
          ) : snippet ? (
            <div className="mg-agent-connection">
              <div className="mg-agent-connection-head">
                <div className="mg-agent-connection-identity">
                  <span className="mg-agent-connection-stamp" aria-hidden="true">
                    <span>MCP</span>
                    <span>/core</span>
                  </span>
                  <div>
                    <p className="mg-agent-connection-eyebrow">
                      Metagraphed MCP · Bittensor in a box
                    </p>
                    <p className="mg-agent-connection-title">
                      {hasCoreEndpoint ? "Recommended core endpoint" : "MCP connection"}
                    </p>
                  </div>
                </div>
                <RangeControl
                  label="Harness"
                  options={snippets.map((item) => ({ value: item.value, label: item.label }))}
                  value={harness}
                  onChange={setHarness}
                />
              </div>
              <CopyableCode
                value={snippet.code}
                label={`Copy ${snippet.label} setup`}
                truncate={false}
                className="mg-agent-connection-command"
              />
              <div className="mg-agent-connection-meta" aria-label="Connection properties">
                {transport ? <span>{transport}</span> : null}
                {hasCoreEndpoint ? <span>Core discovery</span> : null}
                <span>Full registry callable</span>
              </div>
            </div>
          ) : null
        }
        // `/mcp/core` and not `/mcp`: the core listing is 23 of the 243 tools
        // at a ninth of the token cost and still CALLS all 243, so it is the
        // endpoint an agent should be given. The full one is a `Raw` row for
        // the caller who wants every tool listed up front.
        footnote={
          resources.isPending
            ? "Loading MCP connection details · server card"
            : resources.isError
              ? "MCP connection details are unavailable · server card"
              : snippet
                ? `${snippet.hint} · core endpoint · server card`
                : "server card"
        }
      />

      <AnalyticsSection
        id="tools"
        name="Tools"
        question="Everything the server can answer."
        visual={
          <DataTable
            id="tools"
            rows={shown}
            columns={columns}
            rowKey={(row) => row.key}
            caption="MCP tools"
            source="mcp-tool"
            storageKey="mg-agents-columns"
            loading={resources.isPending}
            error={
              resources.isError ? (
                <ErrorState
                  error={resources.error}
                  context="MCP tools"
                  onRetry={() => void resources.refetch()}
                />
              ) : undefined
            }
            search={{ value: q, onChange: setQ, placeholder: "Tool, family or question" }}
            filters={
              <FilterField label="Family">
                <FilterSelect value={family} onChange={(event) => setFamily(event.target.value)}>
                  <option value="">Any family</option>
                  {families.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </FilterSelect>
              </FilterField>
            }
            empty="No tool matches this search."
          />
        }
        // The served list carries `name` and `title` and nothing else -- no
        // description, no family, no core/full flag -- so the family is
        // derived from the tool's own name, which is a grouping the naming
        // convention already encodes rather than a taxonomy invented here.
        footnote={
          resources.isPending
            ? "Loading MCP tools · families are derived from tool names · server card"
            : resources.isError
              ? "MCP tool registry unavailable · server card"
              : `${formatNumber(shown.length)} of ${formatNumber(
                  tools.length,
                )} · families derived from tool names · server card`
        }
      />

      <Raw rows={rawRows} />
    </AppShell>
  );
}
