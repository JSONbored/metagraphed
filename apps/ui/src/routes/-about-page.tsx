import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AnalyticsSection,
  DataTable,
  EntityHero,
  ExternalLink,
  Fact,
  FactSentence,
  Raw,
  type DataTableColumn,
  type FactCells,
  type RawRow,
} from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { Link } from "@tanstack/react-router";
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import {
  COVERAGE_LEVELS,
  CURATION_LEVELS,
  SCOPE_EXCLUSIONS,
  aboutFacts,
  type TaxonomyLevel,
} from "@/components/metagraphed/about/about-logic";
import { API_BASE, GITHUB_REPO } from "@/lib/metagraphed/config";
import { coverageQuery, freshnessQuery, healthQuery } from "@/lib/metagraphed/queries";

const API_PATHS = ["/api/v1/coverage", "/api/v1/health", "/api/v1/freshness"];

/** Registers the page's sources from INSIDE `AppShell`, which owns the provider. */
function ApiSources() {
  useRegisterApiSource(API_PATHS);
  return null;
}

const LEVEL_COLUMNS: DataTableColumn<TaxonomyLevel>[] = [
  { key: "name", label: "Level", value: (l) => l.name },
  { key: "meaning", label: "What it means", value: (l) => l.meaning },
];

/**
 * About (#11627) — the one page on the site that is mostly words.
 *
 * It used to be a two-column layout: prose on the left in the mono body face,
 * an "At a glance" panel of four linked stat tiles on the right. The tiles are
 * the hero's fact cells now (four numbers belong in the strip every other
 * entity page puts them in), and the prose is the site's only `.mg-prose`
 * body — 16px on a 68ch measure, which is the whole reason that
 * second face is loaded at all.
 *
 * The two taxonomies were `<dl>`s of hand-styled term/description pairs. They
 * are vocabularies with a fixed number of members and one sentence each,
 * which is a table — and being a table means they sort, export, and read the
 * same as every other list of records on the site.
 */
export function AboutPage() {
  // These supporting methodology readings should reach an honest unavailable
  // state promptly. The hero exposes one deliberate refresh for all three;
  // silently holding the whole fact rail in an automatic-retry limbo hides
  // both the failure and the recovery action from the reader.
  const coverage = useQuery({ ...coverageQuery(), retry: 0 });
  const health = useQuery({ ...healthQuery(), retry: 0 });
  const freshness = useQuery({ ...freshnessQuery(), retry: 0 });

  const cells = useMemo<FactCells>(() => {
    const facts = aboutFacts({
      coverage: (coverage.data?.data ?? null) as Record<string, unknown> | null,
      health: (health.data?.data ?? null) as Record<string, unknown> | null,
      freshness: (freshness.data?.data ?? null) as Record<string, unknown> | null,
    });
    // Four sources, four cells, one shape: a query that has not landed shows a
    // pending instrument; a failed query names its unavailable reading; only a
    // completed query without a value shows a dash.
    const pending = [coverage.isPending, coverage.isPending, health.isPending, freshness.isPending];
    const errors = [coverage.isError, coverage.isError, health.isError, freshness.isError];
    const [active, adapters, healthy, fresh] = facts.map((fact, index) => ({
      label: fact.label,
      loading: pending[index],
      kind: errors[index] ? "text" : undefined,
      value: (
        <Link to={fact.href} className="text-ink-strong hover:text-accent">
          {errors[index] ? "Unavailable" : (fact.value ?? "—")}
        </Link>
      ),
    }));
    return [active, adapters, healthy, fresh] as FactCells;
  }, [
    coverage.data,
    coverage.isError,
    coverage.isPending,
    health.data,
    health.isError,
    health.isPending,
    freshness.data,
    freshness.isError,
    freshness.isPending,
  ]);

  const rawRows: RawRow[] = [
    { label: "REST", value: `${API_BASE}/api/v1`, href: `${API_BASE}/api/v1` },
    { label: "GraphQL", value: `${API_BASE}/api/v1/graphql` },
    { label: "MCP", value: `${API_BASE}/mcp` },
    {
      label: "OpenAPI",
      value: `${API_BASE}/api/v1/openapi.json`,
      href: `${API_BASE}/api/v1/openapi.json`,
    },
    { label: "Artifacts", value: `${API_BASE}/metagraph/`, href: `${API_BASE}/metagraph/` },
  ];

  return (
    <AppShell>
      <ApiSources />
      <EntityHero
        name="Methodology & scope"
        action={<ExternalLink href={GITHUB_REPO}>Source on GitHub</ExternalLink>}
        sentence={
          <FactSentence>
            An unofficial, public explorer and integration registry for Bittensor — blocks, subnets,
            validators and accounts alongside the public interfaces each subnet exposes, every one
            of them machine-readable. <Fact>unofficial</Fact>
            <Fact>non-custodial</Fact>
            <Fact>open source</Fact>
          </FactSentence>
        }
        cells={cells}
        live={{
          updatedAt: health.data?.data.generated_at ?? null,
          source: "registry + probes",
          onRefresh: () => {
            void Promise.all([coverage.refetch(), health.refetch(), freshness.refetch()]);
          },
          refreshing: coverage.isFetching || health.isFetching || freshness.isFetching,
        }}
      />

      <AnalyticsSection
        id="scope"
        name="What this is"
        question="Two halves — an explorer over the chain, and a registry over what subnets publish."
        visual={
          <div className="mg-prose flex flex-col gap-2">
            <p>
              The explorer reads chain-direct data — blocks, subnets, validators and accounts — with
              endpoint health, schema drift and freshness alongside it. The registry maps every
              public interface a subnet exposes: APIs, OpenAPI schemas, docs, repos, SSE streams,
              data artifacts and the providers behind them, each with the source evidence that
              proves it and the curation gaps still to fill.
            </p>
            <p>
              Everything is served over REST, GraphQL and MCP, and published as static JSON
              artifacts, so a human, a script and an agent all read the same numbers.
            </p>
          </div>
        }
        footnote="registry truth lives in version control, reviewed in the open — there is no in-app submission flow"
      />

      <AnalyticsSection
        id="not"
        name="What this is not"
        question="Four claims worth making outright rather than leaving to inference."
        visual={
          <div className="mg-prose">
            <ul>
              {SCOPE_EXCLUSIONS.map((claim) => (
                <li key={claim}>{claim}</li>
              ))}
            </ul>
          </div>
        }
      />

      <AnalyticsSection
        id="curation"
        name="Curation levels"
        question="How a subnet's overlay came to exist, from chain identity to a typed adapter."
        visual={
          <DataTable
            caption="Curation levels"
            captionHidden
            rows={CURATION_LEVELS}
            columns={LEVEL_COLUMNS}
            rowKey={(level) => level.name}
            source="curation-levels"
            paginate={false}
          />
        }
        footnote="a subnet's level is the highest rung any of its surfaces has reached"
      />

      <AnalyticsSection
        id="coverage"
        name="Coverage levels"
        question="How far through that ladder a subnet has got."
        visual={
          <DataTable
            caption="Coverage levels"
            captionHidden
            rows={COVERAGE_LEVELS}
            columns={LEVEL_COLUMNS}
            rowKey={(level) => level.name}
            source="coverage-levels"
            paginate={false}
          />
        }
        footnote="counted per level on /health and in the coverage artifact"
      />

      <AnalyticsSection
        id="interfaces"
        name="Interfaces"
        question="The same registry, four ways in."
        visual={<Raw title="Endpoints" rows={rawRows} defaultOpen />}
        footnote="JSON Schema is canonical — OpenAPI and the typed clients are projections of it"
      />
    </AppShell>
  );
}
