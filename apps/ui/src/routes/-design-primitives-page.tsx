import { useMemo, useState, type CSSProperties } from "react";
import {
  ActiveEntityProvider,
  AnalyticsSection,
  ChartTooltip,
  COMPOSITION_SPECIMEN,
  CompareLedger,
  CompositionBreakdown,
  CopyableCode,
  DataTable,
  Definition,
  DefinitionsProvider,
  EntityHero,
  Fact,
  FactSentence,
  FactStrip,
  FilterField,
  FilterInput,
  FilterSelect,
  LEADER_SPECIMEN,
  LeaderCards,
  LineWithWindow,
  LiveMeta,
  LoadMore,
  MARKER_SPECIMEN,
  MarkerRail,
  RAIL_SPECIMEN,
  RangeControl,
  RankGrid,
  RankedRails,
  Raw,
  RawCode,
  SectionNav,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  StackedColumns,
  lineSpecimen,
  markAriaLabel,
  stackedSpecimen,
  useEntityMark,
  useIsActive,
  type DataTableColumn,
  type RawRow,
  type SectionNavItem,
} from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { RouterLink } from "@/components/metagraphed/router-link";
import { DESIGN_TOKENS } from "@/components/metagraphed/design/design-tokens.generated";
import { PropsTable } from "@/components/metagraphed/design/props-table";
import {
  COMPARE_PROPS,
  COPY_PROPS,
  DATA_TABLE_PROPS,
  DOCUMENT_PROPS,
  FACT_PROPS,
  FILTER_PROPS,
  HERO_PROPS,
  INTERACTION_PROPS,
  LIVE_META_PROPS,
  RANGE_PROPS,
  RANK_PROPS,
  RAW_PROPS,
  SHEET_PROPS,
  TEMPORAL_PROPS,
} from "@/components/metagraphed/design/primitive-props";
import { DEFINITIONS } from "@/lib/metagraphed/definitions";
import { formatDecimal, formatPct, formatTao } from "@/lib/metagraphed/format";

/**
 * /design/primitives — the documentation of the design system (#11627).
 *
 * One `AnalyticsSection` per primitive, in the order of the epic
 * (#11606–#11611), each carrying its live specimen, its props as a
 * `DataTable`, and the measured anatomy of the thing it renders. Then the
 * tokens, GENERATED from `packages/ui-kit/src/styles.css` so the page cannot
 * document a colour the app has stopped shipping
 * (`design-tokens.generated.ts`, gated by `design-tokens.test.ts`).
 *
 * It is not an `AnalyticsPage`: that wrapper caps a route at seven sections
 * because a route answers at most seven questions, and this page is a
 * reference rather than a route with a subject. It mounts the same
 * `ActiveEntityProvider` and `SectionNav` by hand instead.
 *
 * Every specimen renders from a fixed sample — never `Date.now()` — because
 * the page must render identically under SSR and hydration
 * (docs/ssr-safety.md), and because three Playwright projects drive these
 * specimens as the primitives' only integration test.
 */
const SAMPLE_UPDATED_AT = "2026-07-24T18:44:00.000Z";

const SECTIONS: SectionNavItem[] = [
  { id: "document", name: "Document" },
  { id: "entity-hero", name: "Hero" },
  { id: "facts", name: "Facts" },
  { id: "live-meta", name: "Liveness" },
  { id: "range-control", name: "Range" },
  { id: "raw", name: "Raw" },
  { id: "interaction", name: "Interaction" },
  { id: "data-table", name: "Table" },
  { id: "charts", name: "Charts" },
  { id: "rank", name: "Ranking" },
  { id: "compare", name: "Compare" },
  { id: "filters", name: "Filters" },
  { id: "copyable-code", name: "Copy" },
  { id: "sheet", name: "Sheet" },
  { id: "tokens", name: "Tokens" },
];

const LINE_SPECIMEN = lineSpecimen(120);
const STACKED_SPECIMEN = stackedSpecimen();

const formatTokens = (value: number) => `${value}T`;
const formatMillions = (value: number) => `${formatDecimal(value / 1_000_000, 2)}M τ`;
const formatThousands = (value: number) => `${formatDecimal(value / 1000, 0)}k τ`;

const SOURCE_ROWS: readonly RawRow[] = [
  {
    label: "primitives",
    value: "packages/ui-kit/src/components/metagraphed/",
    copyLabel: "primitives path",
  },
  { label: "tokens", value: "packages/ui-kit/src/styles.css", copyLabel: "stylesheet path" },
  {
    label: "tokens table",
    value: "apps/ui/src/components/metagraphed/design/design-tokens.generated.ts",
    copyLabel: "generated tokens path",
  },
  {
    label: "generator",
    value: "apps/ui/scripts/generate-design-tokens.ts",
    copyLabel: "generator path",
  },
];

export function PrimitivesPreview() {
  return (
    <AppShell>
      <DefinitionsProvider definitions={DEFINITIONS}>
        <ActiveEntityProvider>
          <EntityHero
            crumbs={[{ label: "Design", href: "/design/primitives" }, { label: "Primitives" }]}
            name="Design system"
            action={
              <RouterLink href="/docs" className="mg-hero-action">
                Read the docs
              </RouterLink>
            }
            sentence={
              <FactSentence>
                Every primitive the app is built from, with its live specimen, its props and its
                measured anatomy · <Fact>14 primitives</Fact> ·{" "}
                <Fact>{DESIGN_TOKENS.length} tokens</Fact> · <Fact>2 themes</Fact> ·{" "}
                <Fact>1 radius</Fact>
              </FactSentence>
            }
          />
          <SectionNav items={SECTIONS} />

          <DocumentSection />
          <HeroSection />
          <FactsSection />
          <LiveMetaSection />
          <RangeSection />
          <RawSection />
          <InteractionSection />
          <TableSection />
          <ChartsSection />
          <RankSection />
          <CompareSection />
          <FiltersSection />
          <CopySection />
          <SheetSection />
          <TokensSection />

          <Raw rows={SOURCE_ROWS} />
        </ActiveEntityProvider>
      </DefinitionsProvider>
    </AppShell>
  );
}

/* ---------------------------------------------------------------- document */

function DocumentSection() {
  return (
    <AnalyticsSection
      id="document"
      name="AnalyticsPage · AnalyticsSection"
      question="The document layer: a route is a hero and at most seven sections, each answering one question."
      visual={
        <div className="rounded border border-rule">
          <AnalyticsSection
            id="document-specimen"
            name="Emission"
            question="Which subnets the chain pays, per block."
            controls={<RangeDemo />}
            visual={
              <RankGrid
                items={COMPOSITION_SPECIMEN.map((segment, index) => ({
                  key: `doc-${segment.key}`,
                  label: segment.label,
                  value: `${segment.value}%`,
                  swatch: `var(--chart-${index + 1})`,
                }))}
                cols={3}
                ariaLabel="Emission split (section specimen)"
                source="document-specimen"
              />
            }
            footnote="7d · chain"
          />
        </div>
      }
      legend={<PropsTable rows={DOCUMENT_PROPS} caption="Document layer props" />}
      footnote="28px heading, 600 on the subject · 40px under it · 80/40px section padding, 64/32 at 1184, 48/24 at 640 · 1px rule between sections · 11px sticky nav"
    />
  );
}

/* -------------------------------------------------------------- entity hero */

function HeroSection() {
  return (
    <AnalyticsSection
      id="entity-hero"
      name="EntityHero"
      question="The masthead every entity route opens with: crumbs, name, one action, the sentence, the strip."
      visual={
        <div className="rounded border border-rule">
          <EntityHero
            crumbs={[{ label: "Subnets", href: "/subnets" }, { label: "SN19" }]}
            name="Nineteen"
            action={
              <RouterLink href="/subnets/19" className="mg-hero-action">
                Open subnet
              </RouterLink>
            }
            sentence={
              <FactSentence>
                Ranked <Fact>#04</Fact> by emission with <Fact>4.3%</Fact> of daily emission ·{" "}
                <Fact>247/256</Fact> UIDs · <Fact>OK</Fact> for <Fact>75d</Fact>
              </FactSentence>
            }
            cells={[
              { label: "Emission", value: "4.3%", delta: { text: "+0.2", tone: "good" } },
              { label: "Alpha price", value: "0.0722 τ", delta: { text: "−1.4%", tone: "bad" } },
              { label: "Total stake", value: "3.58M τ" },
              { label: "UIDs", value: "247/256" },
            ]}
          />
        </div>
      }
      legend={<PropsTable rows={HERO_PROPS} caption="EntityHero props" />}
      // No `live` on the specimen: LiveMeta throws on a second mount, and the
      // page's one liveness line belongs to the section that documents it.
      footnote="10px crumb chips · 40px name, 500 · 40px avatar · 32px action · 16px sentence · 4px radius · the hero renders LiveMeta, so a page has exactly one"
    />
  );
}

/* -------------------------------------------------------------------- facts */

function FactsSection() {
  return (
    <AnalyticsSection
      id="facts"
      name="FactSentence · Fact · FactStrip"
      question="The two ways an entity states its numbers: one sentence of chips, then a row of bordered cells."
      visual={
        <div className="space-y-6">
          <FactSentence>
            <Fact>129</Fact> subnets · <Fact>284</Fact> verified surfaces · <Fact>OK</Fact> for{" "}
            <Fact>75d</Fact> · <Fact>application</Fact>
          </FactSentence>
          <FactStrip
            cells={[
              { label: "Emission", value: "4.3%", delta: { text: "+0.2", tone: "good" } },
              { label: "Alpha price", value: "0.0722 τ", delta: { text: "−1.4%", tone: "bad" } },
              { label: "Total stake", value: "3.58M τ" },
              { label: "UIDs", value: "247/256" },
            ]}
          />
          <FactStrip
            variant="grid"
            cells={[
              { label: "Registered", value: "247" },
              { label: "Serving", value: "231" },
              { label: "Validators", value: "16" },
              { label: "Immunity", value: "5,000" },
              { label: "Tempo", value: "360" },
              { label: "Burn", value: "1.42 τ" },
            ]}
          />
        </div>
      }
      legend={<PropsTable rows={FACT_PROPS} caption="Fact props" />}
      footnote="16px sentence · 11px chips on --layer, 18px line · 11px cell labels · 28px values, 500, tabular · 10px delta chip · shared cell edges, 4px radius on the outer box only"
    />
  );
}

/* ---------------------------------------------------------------- liveness */

function LiveMetaSection() {
  return (
    <AnalyticsSection
      id="live-meta"
      name="LiveMeta"
      question="The page's one liveness line — how old the data is, where it came from, and how to ask again."
      visual={
        // The page's ONLY LiveMeta. A second mount throws in development, by
        // design: a route cannot grow a second clock.
        <LiveMeta updatedAt={SAMPLE_UPDATED_AT} source="chain" onRefresh={() => {}} />
      }
      legend={<PropsTable rows={LIVE_META_PROPS} caption="LiveMeta props" />}
      footnote="11px muted · `Updated 9s ago · source · refresh` · one per page, enforced at runtime in development"
    />
  );
}

/* ------------------------------------------------------------ range control */

function RangeSection() {
  return (
    <AnalyticsSection
      id="range-control"
      name="RangeControl"
      question="The one segmented control: a window, a unit, a mode — never a dropdown, never a tab bar."
      visual={
        <div className="flex flex-wrap items-start gap-6">
          <RangeDemo />
          <UnitDemo />
        </div>
      }
      legend={<PropsTable rows={RANGE_PROPS} caption="RangeControl props" />}
      footnote="28px track on --layer, 2px padding, 2px gap · 11px options · active option on --raised · 4px radius · role=radiogroup, arrow keys, one Tab stop"
    />
  );
}

function RangeDemo() {
  const [range, setRange] = useState<"7d" | "30d" | "90d">("7d");
  return (
    <RangeControl
      label="Window"
      options={[
        { value: "7d", label: "7d" },
        { value: "30d", label: "30d" },
        { value: "90d", label: "90d" },
      ]}
      value={range}
      onChange={setRange}
    />
  );
}

function UnitDemo() {
  const [unit, setUnit] = useState<"tao" | "alpha" | "usd">("tao");
  return (
    <RangeControl
      label="Value unit"
      options={[
        { value: "tao", label: "TAO" },
        { value: "alpha", label: "α" },
        { value: "usd", label: "USD" },
      ]}
      value={unit}
      onChange={setUnit}
    />
  );
}

/* ---------------------------------------------------------------------- raw */

function RawSection() {
  return (
    <AnalyticsSection
      id="raw"
      name="Raw · RawRow · RawCode"
      question="The disclosure that is the only place a full hotkey, an API URL or a curl line may live outside a table cell."
      visual={
        <Raw
          defaultOpen
          rows={[
            { label: "Coldkey", value: "5GsbTgfvgCH4xdqSkiPb7EaBBFLHjWH5vfEALhJaewSFpZX9" },
            {
              label: "OpenAPI",
              value: "https://api.metagraph.sh/openapi.json",
              href: "https://api.metagraph.sh/openapi.json",
            },
          ]}
        >
          <RawCode label="curl">{"curl https://api.metagraph.sh/api/v1/subnets/19"}</RawCode>
        </Raw>
      }
      legend={<PropsTable rows={RAW_PROPS} caption="Raw props" />}
      footnote="13px summary with a 6px disclosure square · 10px RAW chip · 13px rows, wrapping, never truncated · 11px code block · mounted last on a page"
    />
  );
}

/* -------------------------------------------------------------- interaction */

const DEMO_KEYS = Array.from({ length: 12 }, (_, i) => `m-${i + 1}`);
const DEMO_VALUES = [42, 58, 35, 71, 64, 29, 80, 53, 47, 66, 38, 75];

function InteractionSection() {
  return (
    <AnalyticsSection
      id="interaction"
      name="ActiveEntity · ChartTooltip · Definition"
      question="One active entity per page: hover, focus or tap any mark and every element carrying that key lights up."
      visual={
        <div className="space-y-6">
          <EntityDemo />
          <div className="flex flex-wrap items-center gap-6" data-testid="definition-demo">
            <span className="inline-flex items-center gap-1.5 text-13">
              Emission share <Definition term="Emission share" />
            </span>
            <Definition term="Validator take">
              <span className="mg-fact-chip">take 18%</span>
            </Definition>
          </div>
        </div>
      }
      legend={<PropsTable rows={INTERACTION_PROPS} caption="Interaction props" />}
      footnote="192px tooltip, 11px rows at 16px, the one shadow · 16×16 definition button, 192px tip at 11px · roving tabindex: one Tab stop per [data-marks] group, arrows inside it, Escape clears"
    />
  );
}

function EntityDemo() {
  const [activated, setActivated] = useState<string>("");
  return (
    // Its own store: the twelve demo marks are a closed group, and the e2e
    // asserts that hovering one lights exactly two elements page-wide.
    <ActiveEntityProvider>
      <div data-testid="entity-demo" className="space-y-3">
        <button type="button" data-testid="entity-demo-before" className="text-11 text-ink-muted">
          before the group
        </button>
        <div className="relative" data-marks>
          <ChartTooltip top={8} />
          <div className="flex h-32 items-end gap-1">
            {DEMO_KEYS.map((key, i) => (
              <DemoBar key={key} index={i} onActivate={setActivated} />
            ))}
          </div>
        </div>
        <ul className="divide-y divide-rule border-y border-rule text-13">
          {DEMO_KEYS.map((key, i) => (
            <DemoRow key={key} index={i} />
          ))}
        </ul>
        <p className="text-11 text-ink-muted">
          activated: <span data-testid="entity-demo-activated">{activated}</span>
        </p>
      </div>
    </ActiveEntityProvider>
  );
}

function DemoBar({ index, onActivate }: { index: number; onActivate: (key: string) => void }) {
  const key = DEMO_KEYS[index]!;
  const value = DEMO_VALUES[index]!;
  const mark = useEntityMark(key, {
    source: "demo-bars",
    label: markAriaLabel(`Mark ${index + 1}`, `${value}%`),
    onActivate: () => onActivate(key),
    data: {
      title: `Mark ${index + 1}`,
      total: `${value}%`,
      rows: DEMO_KEYS.slice(Math.max(0, index - 1), index + 2).map((k) => ({
        key: k,
        label: `Mark ${Number(k.slice(2))}`,
        value: `${DEMO_VALUES[Number(k.slice(2)) - 1]}%`,
        swatch: `var(--chart-${((Number(k.slice(2)) - 1) % 11) + 1})`,
      })),
    },
  });
  return (
    <button
      type="button"
      {...mark}
      className="mg-demo-bar"
      style={
        { "--fill": `${value}%`, "--swatch": `var(--chart-${(index % 11) + 1})` } as CSSProperties
      }
    />
  );
}

function DemoRow({ index }: { index: number }) {
  const active = useIsActive(DEMO_KEYS[index]!);
  return (
    <li
      data-entity={DEMO_KEYS[index]}
      data-active={active ? "true" : undefined}
      className="flex items-center justify-between px-2 py-1"
    >
      <span className="flex items-center gap-2">
        <span
          className="mg-chart-tooltip-swatch"
          style={{ "--swatch": `var(--chart-${(index % 11) + 1})` } as CSSProperties}
          aria-hidden
        />
        Mark {index + 1}
      </span>
      <span className="tabular-nums">{DEMO_VALUES[index]}%</span>
    </li>
  );
}

/* -------------------------------------------------------------------- table */

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

function TableSection() {
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

function ChartsSection() {
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

function RankSection() {
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

function CompareSection() {
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

function FiltersSection() {
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

function CopySection() {
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

function SheetSection() {
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

function TokensSection() {
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
