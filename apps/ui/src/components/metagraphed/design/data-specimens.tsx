/**
 * The specimens that display data: the table, the two temporal charts, the
 * five ranking forms, the compare ledger, the filter controls, the copyable
 * value, the sheet, and the generated token table.
 *
 * Split out of `-design-primitives-page.tsx` by #11678 (600-line page cap).
 */
import { useMemo, useState } from "react";
import {
  AnalyticsSection,
  COMPOSITION_SPECIMEN,
  CompareLedger,
  CompositionBreakdown,
  CopyableCode,
  DataTable,
  FilterField,
  FilterInput,
  FilterSelect,
  LEADER_SPECIMEN,
  LeaderCards,
  LineWithWindow,
  LoadMore,
  MARKER_SPECIMEN,
  MarkerRail,
  RAIL_SPECIMEN,
  RankGrid,
  RankedRails,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  StackedColumns,
  type DataTableColumn,
} from "@jsonbored/ui-kit";
import { RouterLink } from "@/components/metagraphed/router-link";
import { DESIGN_TOKENS } from "@/components/metagraphed/design/design-tokens.generated";
import { PropsTable } from "@/components/metagraphed/design/props-table";
import {
  COMPARE_PROPS,
  COPY_PROPS,
  DATA_TABLE_PROPS,
  FILTER_PROPS,
  RANK_PROPS,
  SHEET_PROPS,
  TEMPORAL_PROPS,
} from "@/components/metagraphed/design/primitive-props";
import { formatDecimal, formatPct, formatTao } from "@/lib/metagraphed/format";
import {
  LINE_SPECIMEN,
  SAMPLE_UPDATED_AT,
  STACKED_SPECIMEN,
  formatMillions,
  formatThousands,
  formatTokens,
} from "./specimen-data";

interface TableRow {
  id: string;
  name: string;
  stake: number;
  health: string;
  seen: string;
  change: number;
}

const TABLE_SPECIMEN: TableRow[] = [
  {
    id: "5GsbTgfvgCH4xdqSkiPb7EaBBFLHjWH5vfEALhJaewSFpZX9",
    name: "Targon",
    stake: 1_890_000,
    health: "ok",
    seen: SAMPLE_UPDATED_AT,
    change: 0.42,
  },
  {
    id: "5CUbyC7Yx8Qk2mJvR4nHtPqLwZaEdFgTbNcVsXyU9i2XSG",
    name: "Chutes",
    stake: 351_600,
    health: "degraded",
    seen: SAMPLE_UPDATED_AT,
    change: -0.12,
  },
  {
    id: "5Ev5mQ3RtYuIoPaSdFgHjKlZxCvBnM7qWeRtYuIo8Pnh9s",
    name: "Affine",
    stake: 169_200,
    health: "down",
    seen: SAMPLE_UPDATED_AT,
    change: 0,
  },
];

const TABLE_COLUMNS: DataTableColumn<TableRow>[] = [
  { key: "name", label: "Operator", sortable: true, value: (row) => row.name },
  { key: "id", label: "Hotkey", kind: "identifier", value: (row) => row.id },
  {
    key: "stake",
    label: "Stake",
    kind: "number",
    sortable: true,
    value: (row) => row.stake,
    format: (value) => formatTao(typeof value === "number" ? value : null),
  },
  { key: "health", label: "Health", kind: "status", value: (row) => row.health },
  { key: "seen", label: "Last probe", kind: "time", value: (row) => row.seen },
  { key: "change", label: "Δ 7d", kind: "delta", value: (row) => row.change },
  {
    key: "share",
    label: "Share",
    kind: "tint",
    demote: true,
    value: (row) => row.stake / 2_500_000,
    tint: (row) => row.stake / 2_500_000,
    format: (value) => `${Math.round((typeof value === "number" ? value : 0) * 100)}%`,
  },
];

export function TableSection() {
  return (
    <AnalyticsSection
      id="data-table"
      name="DataTable"
      question="Every list in the app: eight cell kinds, sorting, paging, a column menu, CSV, and cards below 640px."
      visual={
        <DataTable
          id="table-specimen"
          rows={TABLE_SPECIMEN}
          rowKey={(row) => row.id}
          caption="Validators"
          source="table-specimen"
          rowHref={(row) => `/validators/${row.id}`}
          link={RouterLink}
          columns={TABLE_COLUMNS}
        />
      }
      legend={<PropsTable rows={DATA_TABLE_PROPS} caption="DataTable props" />}
      footnote="44px caption row · 10px uppercase headers, the one place tracking exists · 13px cells in 44px rows, 28px dense · 28px search and menu · head pins inside a 70vh viewport past 20 rows · 4px radius"
    />
  );
}

/* ------------------------------------------------------------------- charts */

export function ChartsSection() {
  return (
    <AnalyticsSection
      id="charts"
      name="StackedColumns · LineWithWindow"
      question="The two temporal charts: composition over periods, and one series' history with a window drawn over it."
      visual={
        <div className="space-y-10">
          <StackedColumns
            {...STACKED_SPECIMEN}
            ariaLabel="Daily emission by subnet (specimen)"
            formatValue={(value) => `${value}τ`}
          />
          <LineWithWindow
            {...LINE_SPECIMEN}
            unit="tokens"
            formatValue={formatTokens}
            ariaLabel="Momentum specimen"
            source="line-specimen"
          />
          {/* The compact variant renders after the full one on purpose: the
              e2e reads `[data-mg-line]` first and asserts the summary, the
              months row and the three markers only the full plot has. */}
          <LineWithWindow
            {...LINE_SPECIMEN}
            compact
            unit="tokens"
            formatValue={formatTokens}
            ariaLabel="Momentum specimen, compact"
            source="line-specimen-compact"
          />
        </div>
      }
      legend={<PropsTable rows={TEMPORAL_PROPS} caption="Temporal chart props" />}
      footnote="344px plot, 15px bars, 12px gap, 40px rotated axis, 8 series + Other · 370px line plot, 120px compact, three 6px markers, a delta chip at the window end · no gridlines, no fill, no y-axis"
    />
  );
}

/* ------------------------------------------------------------------ ranking */

export function RankSection() {
  return (
    <AnalyticsSection
      id="rank"
      name="RankedRails · MarkerRail · RankGrid · LeaderCards · CompositionBreakdown"
      question="Five answers to “which is largest?” — and they share entity keys, so hovering one lights all of them."
      visual={
        <div className="space-y-10">
          <RankedRails
            items={RAIL_SPECIMEN}
            formatValue={formatMillions}
            formatSecondary={formatThousands}
            columns={{
              value: "Stake",
              name: "Validator",
              track: "0–100%",
              secondary: "Emission",
            }}
            ariaLabel="Validators by stake (specimen)"
            source="rails-specimen"
          />
          <MarkerRail
            items={MARKER_SPECIMEN}
            formatValue={(value) => `${formatDecimal(value, 1)}%`}
            columns={{ ratio: "Uptime", name: "Surface", scale: "0–100%" }}
            ariaLabel="Uptime by surface (specimen)"
            source="marker-specimen"
          />
          <CompositionBreakdown
            segments={COMPOSITION_SPECIMEN}
            formatValue={(value) => `${value}%`}
            legendCols={3}
            ariaLabel="Emission split (specimen)"
            source="composition-specimen"
          />
          <RankGrid
            items={RAIL_SPECIMEN.slice(0, 10).map((rail, index) => ({
              key: rail.key,
              label: rail.label,
              value: formatMillions(rail.value),
              share: `${Math.round((rail.value / 5_500_000) * 100)}%`,
              swatch: `var(--chart-${index + 1})`,
              href: `/subnets/${index + 1}`,
              current: index === 2,
            }))}
            cols={5}
            ariaLabel="Peers by emission (specimen)"
            source="rank-grid-specimen"
          />
          <LeaderCards
            items={LEADER_SPECIMEN}
            ariaLabel="Top subnets (specimen)"
            source="leaders-specimen"
          />
        </div>
      }
      legend={<PropsTable rows={RANK_PROPS} caption="Ranking props" />}
      footnote="28px rail rows with a 5px track, 2px apart, 10 before “Show all” · 7px marker rail with ticks every 20% · 30px rank-grid rows with a 6px swatch · 154px featured cards then 88px rows · 24px composition bar with 2px canvas gaps"
    />
  );
}

/* ------------------------------------------------------------------ compare */

export function CompareSection() {
  return (
    <AnalyticsSection
      id="compare"
      name="CompareLedger"
      question="Two or three entities side by side, with the row saying which direction wins and the winner tinted."
      visual={
        <CompareLedger
          ariaLabel="Comparison specimen"
          entities={[
            { key: "a", name: "Apex", sub: "SN1", href: "/subnets/1" },
            { key: "b", name: "Targon", sub: "SN4", href: "/subnets/4" },
          ]}
          groups={[
            {
              label: "Economics",
              rows: [
                {
                  key: "emission",
                  label: "Emission share",
                  values: [0.061, 0.038],
                  better: "high",
                  format: (value) => `${formatPct(typeof value === "number" ? value : 0, 3)}`,
                },
                {
                  key: "cost",
                  label: "Registration cost",
                  values: [12.4, 4.1],
                  better: "low",
                  format: (value) => formatTao(typeof value === "number" ? value : null),
                },
                { key: "slots", label: "Open slots", values: [3, 3], better: "high" },
                { key: "symbol", label: "Symbol", values: ["α", "τ"] },
              ],
            },
          ]}
        />
      }
      legend={<PropsTable rows={COMPARE_PROPS} caption="CompareLedger props" />}
      footnote="64px column heads · 36px group rows · 13px labels and values · a tie has no winner, so nothing is tinted · the label column stays pinned when the entities scroll below 640px"
    />
  );
}

/* ------------------------------------------------------------------ filters */

const FILTER_KINDS = ["REST", "GraphQL", "SSE", "MCP"];

export function FiltersSection() {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  const [shown, setShown] = useState(20);
  return (
    <AnalyticsSection
      id="filters"
      name="FilterField · FilterInput · FilterSelect · LoadMore"
      question="The controls a list narrows itself with, and the strip that fetches the next page of one."
      visual={
        <div className="space-y-6">
          <div className="flex flex-wrap items-end gap-3">
            <FilterField label="Search" grow>
              <FilterInput
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Subnet, operator or surface"
              />
            </FilterField>
            <FilterField label="Kind" hint="4">
              <FilterSelect value={kind} onChange={(event) => setKind(event.target.value)}>
                <option value="">Any kind</option>
                {FILTER_KINDS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </FilterSelect>
            </FilterField>
          </div>
          <div className="rounded border border-rule">
            <LoadMore
              hasMore={shown < 284}
              isLoading={false}
              onLoadMore={() => setShown((current) => Math.min(284, current + 20))}
              shown={shown}
              total={284}
            />
          </div>
        </div>
      }
      legend={<PropsTable rows={FILTER_PROPS} caption="Filter props" />}
      footnote="36px controls · 10px field labels · 13px values · 4px radius · LoadMore is an 11px strip above a 1px rule, with skeleton rows while a page is in flight"
    />
  );
}

/* --------------------------------------------------------------------- copy */

export function CopySection() {
  return (
    <AnalyticsSection
      id="copyable-code"
      name="CopyableCode"
      question="A value you are meant to take with you: shown as code, copied on click, announced to assistive tech."
      visual={
        <div className="flex flex-wrap items-center gap-3">
          <CopyableCode value="5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY" />
          <CopyableCode label="api" value="https://api.metagraph.sh/api/v1/subnets/19" />
          <CopyableCode
            truncate={false}
            value="claude mcp add --transport http metagraphed https://api.metagraph.sh/mcp/core"
          />
        </div>
      }
      legend={<PropsTable rows={COPY_PROPS} caption="CopyableCode props" />}
      footnote="11px chip on --card · 12px copy glyph that swaps for a check on success · 1px border, 4px radius · truncates by default, wraps from 640px up"
    />
  );
}

/* -------------------------------------------------------------------- sheet */

export function SheetSection() {
  return (
    <AnalyticsSection
      id="sheet"
      name="Sheet"
      question="The one slide-in panel: mobile navigation, a row's detail, a form that must not lose the list behind it."
      visual={
        <Sheet>
          <SheetTrigger asChild>
            <button type="button" className="mg-hero-action">
              Open sheet
            </button>
          </SheetTrigger>
          <SheetContent>
            <SheetHeader>
              <SheetTitle>Sample sheet</SheetTitle>
              <SheetDescription>
                A slide-in panel with static content — no network dependency.
              </SheetDescription>
            </SheetHeader>
            <SheetFooter>
              <CopyableCode label="netuid" value="19" />
            </SheetFooter>
          </SheetContent>
        </Sheet>
      }
      legend={<PropsTable rows={SHEET_PROPS} caption="Sheet props" />}
      footnote="slides from the right by default · 75% wide to a 384px maximum · 24px padding · overlay and panel at --mg-z-modal · Escape and the overlay close it, focus returns to the trigger"
    />
  );
}

/* ------------------------------------------------------------------- tokens */

interface TokenRow {
  name: string;
  light: string;
  dark: string;
  theme: string;
  refs: number;
}

const TOKEN_ROWS: TokenRow[] = DESIGN_TOKENS.map((token) => ({
  name: token.name,
  light: token.light,
  // "=" and not a repeat of the light value: the ~30 tokens that actually
  // change between themes are the answer this column exists to give, and
  // restating the other 60 buries them.
  dark: token.dark ?? "=",
  theme: token.theme ?? "—",
  refs: token.refs,
}));

const TOKEN_COLUMNS: DataTableColumn<TokenRow>[] = [
  { key: "name", label: "Token", width: 200, sortable: true, value: (row) => row.name },
  { key: "light", label: "Light", width: 200, value: (row) => row.light },
  { key: "dark", label: "Dark", width: 200, value: (row) => row.dark },
  { key: "theme", label: "Tailwind bridge", width: 200, value: (row) => row.theme },
  {
    key: "refs",
    label: "Reads in CSS",
    kind: "number",
    sortable: true,
    width: 110,
    value: (row) => row.refs,
  },
];

export function TokensSection() {
  const [query, setQuery] = useState("");
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return TOKEN_ROWS;
    return TOKEN_ROWS.filter((row) =>
      `${row.name} ${row.light} ${row.dark} ${row.theme}`.toLowerCase().includes(needle),
    );
  }, [query]);
  const themed = DESIGN_TOKENS.filter((token) => token.dark !== null).length;
  return (
    <AnalyticsSection
      id="tokens"
      name="Tokens"
      question="Every custom property the theme declares, with the value it takes in each theme."
      visual={
        <DataTable
          id="tokens"
          rows={rows}
          columns={TOKEN_COLUMNS}
          rowKey={(row) => row.name}
          caption="Design tokens"
          source="design-token"
          total={TOKEN_ROWS.length}
          paginate={false}
          dense
          mobile="cards"
          search={{ value: query, onChange: setQuery, placeholder: "Token, value or bridge" }}
          empty="No token matches this search."
        />
      }
      // Not a prop table: tokens have no props. The row that would sit here is
      // the one fact a reader needs about the table itself -- that it is
      // generated, and from what.
      footnote={`${TOKEN_ROWS.length} tokens · ${themed} change between light and dark · “Reads in CSS” counts var() in packages/ui-kit/src/styles.css only, so a token a component reads through Tailwind shows 0 · generated by apps/ui/scripts/generate-design-tokens.ts and gated by design-tokens.test.ts`}
    />
  );
}
