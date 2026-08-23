import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AnalyticsSection,
  CopyableCode,
  DataTable,
  EntityHero,
  Fact,
  FactSentence,
  FilterField,
  FilterSelect,
  RangeControl,
  Raw,
  RawCode,
  type DataTableColumn,
  type RawRow,
} from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { RouterLink } from "@/components/metagraphed/router-link";
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import { API_BASE } from "@/lib/metagraphed/config";
import { formatNumber } from "@/lib/metagraphed/format";
import { agentResourcesQuery } from "@/lib/metagraphed/queries";
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
        server_card?: string;
        tools?: Record<string, unknown>[];
      }
    | undefined;
  const tools = useMemo(() => toolRows(mcp?.tools), [mcp]);
  const families = useMemo(() => facet(tools, (row) => row.family), [tools]);
  const shown = useMemo(() => filterTools(tools, q, family), [tools, q, family]);
  const snippets = useMemo(() => connectSnippets(mcp), [mcp]);
  const snippet = snippets.find((item) => item.value === harness) ?? snippets[0];

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
        name="Agents"
        action={
          <RouterLink href="/docs/mcp" className="mg-hero-action">
            Read the MCP docs
          </RouterLink>
        }
        sentence={
          <FactSentence>
            One command points any MCP client at every Bittensor subnet this registry knows.{" "}
            {agentFacts(payload?.summary as Parameters<typeof agentFacts>[0], tools.length, {
              count: formatNumber,
            }).map((fact) => (
              <Fact key={fact.key}>
                {fact.label} {fact.value}
              </Fact>
            ))}
          </FactSentence>
        }
        live={{
          updatedAt: (payload?.generated_at as string | undefined) ?? null,
          source: "server card",
          onRefresh: () => void resources.refetch(),
          refreshing: resources.isFetching,
        }}
      />

      <AnalyticsSection
        id="connect"
        name="Connect"
        question="One line to point an agent here."
        controls={
          <RangeControl
            label="Harness"
            options={snippets.map((item) => ({ value: item.value, label: item.label }))}
            value={harness}
            onChange={setHarness}
          />
        }
        visual={
          snippet ? (
            <>
              <RawCode>{snippet.code}</RawCode>
              <CopyableCode value={snippet.code} className="max-w-full" />
            </>
          ) : null
        }
        // `/mcp/core` and not `/mcp`: the core listing is 23 of the 243 tools
        // at a ninth of the token cost and still CALLS all 243, so it is the
        // endpoint an agent should be given. The full one is a `Raw` row for
        // the caller who wants every tool listed up front.
        footnote={snippet ? `${snippet.hint} · core endpoint · server card` : "server card"}
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
        footnote={`${formatNumber(shown.length)} of ${formatNumber(
          tools.length,
        )} · families derived from tool names · server card`}
      />

      <Raw rows={rawRows} />
    </AppShell>
  );
}
