import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import {
  AnalyticsSection,
  DataTable,
  EntityHero,
  FactSentence,
  RankedRails,
  Raw,
  SectionNav,
  type DataTableColumn,
  type RawRow,
} from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { factCells } from "@/lib/metagraphed/facts";
import { HubSections } from "@/components/metagraphed/hub-prose";
import { RouterLink } from "@/components/metagraphed/router-link";
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import { API_BASE } from "@/lib/metagraphed/config";
import { formatNumber } from "@/lib/metagraphed/format";
import { schemasQuery } from "@/lib/metagraphed/queries";
import {
  apisNav,
  driftRails,
  schemaFacts,
  schemaRows,
  schemaSummary,
  shortHash,
  type SchemaRow,
} from "@/components/metagraphed/apis/apis-logic";

const API_PATHS = ["/api/v1/schemas", "/api/v1/subnets/{netuid}/evidence"];

function ApiSources() {
  useRegisterApiSource(
    API_PATHS.filter((path) => !path.includes("{")),
    ["/metagraph/schemas/index.json"],
  );
  return null;
}

/**
 * Captured schemas and what moved (#11622) — three sections.
 *
 * What went: six count boxes that repeated the hero, a "Data freshness &
 * methodology" essay, a `drifting only / show all` toggle (the table filters),
 * a 64-chip drift matrix, and every paragraph. The 60-row drift-activity list
 * and the matrix were the same 64 rows drawn twice; they are one table now,
 * with the ones that moved ranked above it.
 *
 * The issue asked for a third section of change kinds by week over 26 weeks.
 * /api/v1/schemas publishes ONE snapshot -- a hash, a previous hash and one
 * `observed_at` per surface -- and no history endpoint exists, so there is no
 * series to draw. Rather than a chart of one column, this section asks what
 * the captures actually contain: how large each published spec is, which is
 * the closest question the data can answer and the one that says whether a
 * subnet's "has an OpenAPI" is three paths or three hundred.
 */
export function SchemasPage() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [showAllDrift, setShowAllDrift] = useState(false);
  const schemas = useQuery({ ...schemasQuery(), retry: 0 });

  // `schemasQuery` returns the flat schema ARRAY -- its normalizer keeps the
  // rows and drops the response envelope -- so there is no `.schemas` and no
  // `.summary` to read here. The summary is counted off the rows instead.
  const rows = useMemo(() => schemaRows(schemas.data?.data), [schemas.data]);
  const summary = useMemo(() => schemaSummary(rows), [rows]);
  const rails = useMemo(() => driftRails(rows), [rows]);
  const subnetsCovered = useMemo(
    () => new Set(rows.map((row) => row.netuid).filter((n) => n != null)).size,
    [rows],
  );
  const captured = useMemo(
    () => rows.filter((row) => row.status === "captured" && (row.paths ?? 0) > 0),
    [rows],
  );
  const driftShown = showAllDrift ? rows : rows.filter((row) => row.drift !== "unchanged");

  const columns: DataTableColumn<SchemaRow>[] = [
    {
      key: "subnet",
      label: "Subnet",
      kind: "link",
      width: 120,
      value: (row) => row.netuid ?? null,
      href: (row) => (row.netuid == null ? undefined : `/subnets/${row.netuid}`),
      format: (value) => (typeof value === "number" ? `SN${value}` : "—"),
    },
    { key: "title", label: "Schema", value: (row) => row.title },
    { key: "drift", label: "Drift", kind: "status", width: 160, value: (row) => row.drift },
    { key: "status", label: "Capture", kind: "status", width: 160, value: (row) => row.status },
    {
      key: "paths",
      label: "Paths",
      kind: "number",
      align: "right",
      width: 90,
      value: (row) => row.paths,
    },
    {
      key: "components",
      label: "Components",
      kind: "number",
      align: "right",
      width: 120,
      demote: true,
      value: (row) => row.components,
    },
    {
      key: "hashes",
      label: "Was → now",
      kind: "identifier",
      width: 190,
      demote: true,
      value: (row) => `${shortHash(row.from)} → ${shortHash(row.to)}`,
    },
    {
      key: "observed",
      label: "Captured",
      kind: "time",
      width: 130,
      value: (row) => row.observedAt,
    },
    {
      key: "url",
      label: "Spec",
      kind: "link",
      demote: true,
      value: (row) => row.url,
      href: (row) => row.url ?? undefined,
      format: (value) => (typeof value === "string" ? value.replace(/^https?:\/\//, "") : "—"),
    },
    {
      // The issue asks for an evidence link, and this is what backs a drift
      // claim: /api/v1/subnets/{netuid}/evidence is the captured proof that
      // the subnet publishes what the row says it publishes. It was the only
      // published route with no reference anywhere in apps/ui once the
      // orphaned evidence panel came out, which `validate:ui-route-coverage`
      // reports as a regression -- correctly, since an unreferenced route is
      // one nothing on the site can lead a reader to.
      key: "evidence",
      label: "Evidence",
      kind: "link",
      width: 120,
      demote: true,
      value: (row) => (row.netuid == null ? null : "evidence"),
      href: (row) =>
        row.netuid == null ? undefined : `${API_BASE}/api/v1/subnets/${row.netuid}/evidence`,
    },
  ];

  const sizeRails = useMemo(
    () =>
      [...captured]
        .sort((a, b) => (b.paths ?? 0) - (a.paths ?? 0))
        .slice(0, 15)
        .map((row) => ({
          key: row.key,
          label: row.netuid == null ? row.subnet : `SN${row.netuid} ${row.subnet}`,
          value: row.paths ?? 0,
          href: row.netuid == null ? "/subnets" : `/subnets/${row.netuid}`,
          detail: [
            { key: "title", label: "Title", value: row.title },
            { key: "components", label: "Components", value: formatNumber(row.components ?? 0) },
          ],
        })),
    [captured],
  );

  const rawRows: RawRow[] = API_PATHS.filter((path) => !path.includes("{")).map((path) => ({
    label: path.replace("/api/v1/", ""),
    value: `${API_BASE}${path}`,
    href: `${API_BASE}${path}`,
  }));

  return (
    <AppShell>
      <ApiSources />
      <EntityHero
        name="Schemas"
        sentence={
          <FactSentence>
            JSON Schema is the contract; drift is this capture against the last one.
          </FactSentence>
        }
        // A STRIP, not chips (#11696). This page's subject is a table, and its
        // headline counts were 11px `Fact` chips inside the sentence -- set
        // smaller than the rows they frame. The lede stays prose.
        cells={
          factCells(schemaFacts(summary, subnetsCovered, { count: formatNumber })) ?? undefined
        }
        live={{
          updatedAt: summary.observed_at,
          source: "snapshot",
          onRefresh: () => void schemas.refetch(),
          refreshing: schemas.isFetching,
        }}
      />
      <SectionNav items={apisNav(pathname)} link={RouterLink} />

      <AnalyticsSection
        id="drift"
        name="Drift"
        question="Which schemas changed, and how much surface changed with them."
        visual={
          rails.length > 0 ? (
            <RankedRails
              items={rails}
              formatValue={(value: number) => `${formatNumber(value)} paths`}
              scale="sqrt"
              columns={{ value: "Paths", name: "Subnet", track: "Size of the spec that moved" }}
              ariaLabel="Schemas that changed since the last capture"
              source="schema-drift"
            />
          ) : null
        }
        legend={
          <DataTable
            id="drift-table"
            rows={driftShown}
            columns={columns}
            rowKey={(row) => row.key}
            caption={showAllDrift ? "Every tracked schema" : "Schemas that moved"}
            link={RouterLink}
            source="schema"
            storageKey="mg-schemas-columns"
            loading={schemas.isPending}
            filters={
              <button
                type="button"
                className="mg-section-more"
                onClick={() => setShowAllDrift((v) => !v)}
              >
                {showAllDrift ? "Only what moved" : `Show all ${formatNumber(rows.length)}`}
              </button>
            }
            empty="Nothing moved since the last capture."
          />
        }
        // Ranked on the size of the spec, not on a diff score: no change
        // weight is published, and a subnet whose 35-path spec changed moved
        // more than one whose capture failed. The seven that could not be
        // captured are in the table below rather than as empty rails.
        footnote="ranked by paths in the captured spec · snapshot"
      />

      <AnalyticsSection
        id="size"
        name="Size"
        question="How much each captured spec actually documents."
        visual={
          sizeRails.length > 0 ? (
            <RankedRails
              items={sizeRails}
              formatValue={(value: number) => `${formatNumber(value)} paths`}
              scale="sqrt"
              columns={{ value: "Paths", name: "Subnet", track: "Documented operations" }}
              ariaLabel="Captured schemas by size"
              source="schema-size"
            />
          ) : null
        }
        // The issue asked for change kinds by week over 26 weeks.
        // /api/v1/schemas publishes ONE snapshot -- a hash, a previous hash
        // and one observed_at per surface -- and no history endpoint exists,
        // so there is no series to draw. This asks the closest question the
        // data can answer, and the one that says whether a subnet's "has an
        // OpenAPI" is three paths or three hundred.
        footnote="current snapshot · no per-week history is published · snapshot"
      />

      {/* #11320: below the data on purpose -- see hub-prose.tsx. */}
      <HubSections path="/apis/schemas" />

      <Raw rows={rawRows} />
    </AppShell>
  );
}
