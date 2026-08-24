import { useMemo } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  AnalyticsSection,
  DataTable,
  EntityHero,
  FactSentence,
  FilterField,
  FilterSelect,
  MarkerRail,
  Raw,
  type DataTableColumn,
  type RawRow,
} from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { factCells } from "@/lib/metagraphed/facts";
import { RouterLink } from "@/components/metagraphed/router-link";
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import { API_BASE } from "@/lib/metagraphed/config";
import { formatNumber } from "@/lib/metagraphed/format";
import { coverageQuery, gapsQuery } from "@/lib/metagraphed/queries";
import {
  contributeFacts,
  coverageMarkers,
  facet,
  gapRows,
  type GapRow,
} from "@/components/metagraphed/builder/builder-logic";
import { Route } from "./contribute";

const API_PATHS = ["/api/v1/gaps", "/api/v1/coverage", "/api/v1/curation"];

function ApiSources() {
  useRegisterApiSource(API_PATHS);
  return null;
}

/**
 * Contribute (#11626) — two sections.
 *
 * What went: 1,369 lines, fourteen `AsyncPanel`s, four tables, an enrichment
 * queue, an evidence panel, an attribution funnel, a registry-score histogram
 * and a dimension-coverage heatmap. Every one of them was a different view of
 * the same question — what is missing — and the queue below answers it in the
 * order the curation lane itself ranks.
 */
export function GapsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/contribute" });
  const setSearch = (patch: Record<string, unknown>) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
      resetScroll: false,
    });

  const gaps = useSuspenseQuery(gapsQuery()).data;
  const coverage = useQuery({ ...coverageQuery(), retry: 0 });

  const rows = useMemo(() => gapRows(gaps.data), [gaps.data]);
  const kinds = useMemo(
    () => [...new Set(rows.flatMap((row) => row.missing))].sort((a, b) => a.localeCompare(b)),
    [rows],
  );
  const severities = useMemo(() => facet(rows, (row) => row.severity), [rows]);

  const shown = useMemo(() => {
    const q = search.q.trim().toLowerCase();
    return rows.filter((row) => {
      if (search.missing && !row.missing.includes(search.missing)) return false;
      if (search.severity && row.severity !== search.severity) return false;
      if (!q) return true;
      return `${row.name} ${row.slug} sn${row.netuid}`.toLowerCase().includes(q);
    });
  }, [rows, search]);

  const completeness = coverage.data?.data.completeness as
    | {
        dimension_coverage?: Record<string, { pct?: number; present?: number }>;
        average_score?: number;
      }
    | undefined;
  const total = (coverage.data?.data.chain_subnet_count as number | undefined) ?? 0;
  const markers = useMemo(
    () => coverageMarkers(completeness?.dimension_coverage, { count: formatNumber }),
    [completeness],
  );

  const tableColumns: DataTableColumn<GapRow>[] = [
    {
      key: "subnet",
      label: "Subnet",
      kind: "link",
      width: 200,
      value: (row) => row.netuid,
      href: (row) => `/subnets/${row.netuid}`,
      format: (value, row) => (typeof value === "number" ? `SN${value} ${row.name}` : row.name),
    },
    {
      key: "missing",
      label: "Missing",
      value: (row) => row.missing.join(", "),
    },
    {
      key: "gaps",
      label: "Gaps",
      kind: "number",
      align: "right",
      width: 90,
      value: (row) => row.gapCount,
    },
    {
      key: "severity",
      label: "Severity",
      kind: "status",
      width: 120,
      value: (row) => row.severity,
    },
    {
      key: "note",
      label: "Why it is open",
      kind: "text",
      // The one prose cell in the app, and the only column that opts out of
      // the one-line default: the lane's own sentence about why a gap is
      // expected is worth reading. Two lines of it, capped -- unbounded, a
      // 300-character note made its row 395px tall beside 56px neighbours
      // (#11698). The whole sentence is under the row.
      wrap: true,
      value: (row) => row.note,
    },
    {
      key: "coverage",
      label: "Coverage",
      kind: "status",
      width: 140,
      demote: true,
      value: (row) => row.coverage,
    },
    {
      key: "curation",
      label: "Curation",
      kind: "status",
      width: 180,
      demote: true,
      value: (row) => row.curation,
    },
    {
      key: "supported",
      label: "Already published",
      demote: true,
      value: (row) => row.supported.join(", "),
    },
  ];

  const rawRows: RawRow[] = [
    ...API_PATHS.map((path) => ({
      label: path.replace("/api/v1/", ""),
      value: `${API_BASE}${path}`,
      href: `${API_BASE}${path}`,
    })),
    {
      label: "gaps feed",
      value: `${API_BASE}/api/v1/feeds/gaps.json`,
      href: `${API_BASE}/api/v1/feeds/gaps.json`,
    },
  ];

  return (
    <AppShell>
      <ApiSources />
      <EntityHero
        name="Contribute"
        action={
          <RouterLink href="/docs/contributing" className="mg-hero-action">
            Read the guide
          </RouterLink>
        }
        sentence={<FactSentence>What is missing, in the order the registry ranks it.</FactSentence>}
        // A STRIP, not chips (#11696). This page's subject is a table, and its
        // headline counts were 11px `Fact` chips inside the sentence -- set
        // smaller than the rows they frame. The lede stays prose.
        cells={
          factCells(
            contributeFacts(rows, coverage.data?.data as Parameters<typeof contributeFacts>[1], {
              count: formatNumber,
            }),
          ) ?? undefined
        }
        live={{
          updatedAt: (gaps.meta?.generated_at as string | undefined) ?? null,
          source: "registry",
        }}
      />

      <AnalyticsSection
        id="queue"
        name="Queue"
        question="What to add next, in the order the registry ranks it."
        visual={
          <DataTable
            id="queue"
            rows={shown}
            columns={tableColumns}
            rowKey={(row) => row.key}
            caption="Subnets with an open gap"
            rowHref={(row) => `/subnets/${row.netuid}`}
            link={RouterLink}
            source="gap"
            storageKey="mg-contribute-columns"
            expand={(row) =>
              row.note ? (
                <dl>
                  <div className="mg-raw-row">
                    <dt>Why it is open</dt>
                    <dd>{row.note}</dd>
                  </div>
                </dl>
              ) : null
            }
            search={{
              value: search.q,
              onChange: (q) => setSearch({ q }),
              placeholder: "Subnet name or netuid",
            }}
            filters={
              <>
                <FilterField label="Missing">
                  <FilterSelect
                    value={search.missing}
                    onChange={(event) => setSearch({ missing: event.target.value })}
                  >
                    <option value="">Any surface</option>
                    {kinds.map((kind) => (
                      <option key={kind} value={kind}>
                        {kind}
                      </option>
                    ))}
                  </FilterSelect>
                </FilterField>
                <FilterField label="Severity">
                  <FilterSelect
                    value={search.severity}
                    onChange={(event) => setSearch({ severity: event.target.value })}
                  >
                    <option value="">Any severity</option>
                    {severities.map((severity) => (
                      <option key={severity} value={severity}>
                        {severity}
                      </option>
                    ))}
                  </FilterSelect>
                </FilterField>
              </>
            }
            empty="No subnet matches these filters."
          />
        }
        // `gap_priority` is used AS GIVEN. A page that re-ranked gaps by its
        // own weighting would send contributors somewhere the curation lane
        // did not ask them to go; the `Why it is open` cell carries the lane's
        // own note, so a gap that is expected says so before anyone spends an
        // evening on it.
        footnote={`${formatNumber(shown.length)} of ${formatNumber(
          rows.length,
        )} · ranked by the registry's own gap priority · registry`}
      />

      <AnalyticsSection
        id="coverage"
        name="Coverage"
        question="What share of subnets publish each kind of surface."
        visual={
          markers.length > 0 ? (
            <MarkerRail
              items={markers}
              max={100}
              formatValue={(value) => `${value}%`}
              columns={{ ratio: "Covered", name: "Surface kind", scale: "Share of subnets" }}
              ariaLabel="Subnets publishing each kind of surface"
              source="coverage-dimension"
            />
          ) : null
        }
        // By KIND, not by domain. `domain_coverage` counts subnets per domain
        // and is not a completeness reading at all; `dimension_coverage` is
        // one, per surface kind, over the whole set -- which is the question a
        // contributor is asking. The rail is the only rendering of it now:
        // /apis/schemas drew the same field on the same day (#11693).
        footnote={`of ${formatNumber(total)} subnets · registry`}
      />

      <Raw rows={rawRows} />
    </AppShell>
  );
}
