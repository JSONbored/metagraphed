import { Activity, Layers, Radio, Server } from "lucide-react";
import { useState, type CSSProperties, type ReactNode } from "react";
import {
  Breadcrumbs,
  Chip,
  ColumnCustomizer,
  EmptyState,
  FilterField,
  FilterInput,
  FilterSelect,
  FilterToolbar,
  GhostButton,
  Indicator,
  LoadingPill,
  Panel,
  StatusBadge,
  TableSkeleton,
  useColumnVisibility,
  type ColumnDef,
} from "@/components/metagraphed/primitives";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  AnimatedNumber,
  BarMini,
  LineWithWindow,
  StackedColumns,
  TrendDelta,
  lineSpecimen,
  stackedSpecimen,
  BrandIcon,
  CandidateChip,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CopyButton,
  CopyIconToggle,
  CopyableCode,
  CurationChip,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Divider,
  DiscordIcon,
  Donut,
  DonutLegend,
  DownloadCsvButton,
  EligibilityChip,
  EntityHero,
  ExternalLink,
  FilterChipRow,
  FilterSheet,
  HealthDot,
  HealthPill,
  Kbd,
  SectionHead,
  AnalyticsPage,
  AnalyticsSection,
  Fact,
  FactSentence,
  RangeControl,
  ActiveEntityProvider,
  ChartTooltip,
  Definition,
  DefinitionsProvider,
  Raw,
  RawCode,
  useEntityMark,
  useIsActive,
  markAriaLabel,
  KeyChip,
  ListShell,
  LoadMore,
  McpToolsList,
  PanelError,
  PanelHeader,
  PanelSkeleton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ProvenanceChip,
  QueryBar,
  QueryProgress,
  ReadinessGauge,
  ResponsiveTable,
  ReviewChip,
  RoutePending,
  ScrollShadow,
  ShareButton,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  Skeleton,
  TableState,
  TimeAgo,
  TreemapMini,
  ViewModeToggle,
  Wordmark,
  YieldPercentileStrip,
} from "@jsonbored/ui-kit";
import { GITHUB_REPO_URL } from "@/lib/metagraphed/identity";
import { DEFINITIONS } from "@/lib/metagraphed/definitions";

const COLUMNS: ColumnDef[] = [
  { id: "netuid", label: "Netuid", required: true },
  { id: "name", label: "Name", required: true },
  { id: "curation", label: "Curation" },
  { id: "surfaces", label: "Surfaces" },
  { id: "endpoints", label: "Endpoints" },
  { id: "health", label: "Health" },
  { id: "trend", label: "7d Trend", defaultVisible: false },
  { id: "updated", label: "Updated", defaultVisible: false },
];

// A fixed sample timestamp, not `Date.now()` -- this page must render
// deterministically (see the page description below): a live clock read at
// render time differs between the SSR pass and client hydration, which is a
// real hydration-mismatch footgun (docs/ssr-safety.md), not just noise.
const SAMPLE_UPDATED_AT = "2026-07-24T18:44:00.000Z";

export function PrimitivesPreview() {
  const cols = useColumnVisibility("primitives-preview", COLUMNS);
  const updated = SAMPLE_UPDATED_AT;

  return (
    <div className="mx-auto max-w-5xl px-4 md:px-6 pb-16">
      <div className="pt-6">
        <Breadcrumbs
          crumbs={[
            { label: "Registry", to: "/" },
            { label: "Design", to: "/design/primitives" },
            { label: "Primitives", to: "/design/primitives" },
          ]}
        />
      </div>
      <SectionHead
        name="Design primitives"
        question="Every component in the kit, in both themes, with the import to copy."
      />

      <TabNav />

      <TokensSection cols={cols} />
      <LayoutSection updated={updated} />
      <DataDisplaySection />
      <ChartsSection />
      <DefinitionsProvider definitions={DEFINITIONS}>
        <InteractionSection />
      </DefinitionsProvider>
      <FeedbackSection updated={updated} />

      <p className="mt-10 text-13 text-ink-muted">
        Applied on: /subnets grid cards · /endpoints card list · every route in the app
      </p>
    </div>
  );
}

/* ---------- in-page nav ---------- */

const NAV_SECTIONS = [
  { id: "tokens", label: "Tokens" },
  { id: "layout", label: "Layout" },
  { id: "data-display", label: "Data display" },
  { id: "charts", label: "Charts" },
  { id: "interaction", label: "Interaction" },
  { id: "feedback", label: "Feedback" },
] as const;

function TabNav() {
  return (
    <nav
      aria-label="Design primitives sections"
      className="sticky top-0 z-[var(--mg-z-sticky)] -mx-4 mb-2 flex gap-1 overflow-x-auto border-b border-border bg-paper px-4 py-2 md:mx-0 md:px-0"
    >
      {NAV_SECTIONS.map((s) => (
        <a
          key={s.id}
          href={`#${s.id}`}
          className="shrink-0 rounded px-2.5 py-1 text-11 text-ink-muted hover:bg-surface hover:text-ink-strong"
        >
          {s.label}
        </a>
      ))}
    </nav>
  );
}

/* ---------- shared showcase primitives ---------- */

/** One showcased component: a label, its live render, and a copyable import line. */
function Show({
  name,
  from = "@jsonbored/ui-kit",
  children,
}: {
  name: string;
  from?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-2 rounded border border-border bg-card p-3">
      <div className="text-13 text-ink-muted">{name}</div>
      <div>{children}</div>
      <CopyableCode value={`import { ${name} } from "${from}";`} truncate={false} />
    </div>
  );
}

function Section({ title, children, id }: { title: string; children: ReactNode; id?: string }) {
  return (
    <section id={id} className="mt-10 scroll-mt-24">
      <h2 className="mb-3 font-display text-16 font-semibold text-ink-strong">{title}</h2>
      {children}
    </section>
  );
}

function SwatchRow({ label, sample }: { label: string; sample: ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded border border-border bg-card px-3 py-2">
      <span className="w-28 shrink-0 font-mono text-10 text-ink-muted">{label}</span>
      {sample}
    </div>
  );
}

/* ---------- Tokens ---------- */

const SPACE_TOKENS = [
  ["--mg-space-3xs", "2px"],
  ["--mg-space-2xs", "4px"],
  ["--mg-space-xs", "8px"],
  ["--mg-space-sm", "12px"],
  ["--mg-space-md", "16px"],
  ["--mg-space-lg", "24px"],
  ["--mg-space-xl", "32px"],
  ["--mg-space-2xl", "48px"],
  ["--mg-space-3xl", "64px"],
] as const;

const TYPE_TOKENS = [
  ["text-13", "10px micro label"],
  ["text-11", "11px label"],
  ["text-13", "12px caption"],
  ["text-13", "13px caption"],
  ["text-10", "12px tabular data"],
  ["text-11", "13px tabular data"],
] as const;

const SHADOW_TOKENS = ["--mg-shadow-tooltip"] as const;

const Z_TOKENS = [
  ["--mg-z-sticky", "10"],
  ["--mg-z-raised", "20"],
  ["--mg-z-nav", "30"],
  ["--mg-z-overlay", "40"],
  ["--mg-z-modal", "50"],
  ["--mg-z-progress", "60"],
  ["--mg-z-skip-link", "100"],
] as const;

const RADIUS_TOKENS = [
  ["rounded", "pills, badges, avatars"],
  ["rounded", "inputs, buttons, chips"],
  ["rounded", "cards, popovers"],
  ["rounded", "drawers, modals, sheets"],
  ["rounded", "hero tiles, panels"],
] as const;

function TokensSection({ cols }: { cols: ReturnType<typeof useColumnVisibility> }) {
  return (
    <Section id="tokens" title="Tokens">
      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="Spacing scale" caption="--mg-space-*">
          <div className="space-y-1.5">
            {SPACE_TOKENS.map(([name, px]) => (
              <SwatchRow
                key={name}
                label={name}
                sample={
                  <span
                    className="block h-3 rounded bg-accent/70"
                    style={{ width: `var(${name})` }}
                    title={px}
                  />
                }
              />
            ))}
          </div>
        </Panel>
        <Panel title="Type scale" caption="mg-type-*">
          <div className="space-y-1.5">
            {TYPE_TOKENS.map(([cls, desc]) => (
              <SwatchRow key={cls} label={cls} sample={<span className={cls}>{desc}</span>} />
            ))}
          </div>
        </Panel>
        <Panel title="Elevation scale" caption="--mg-shadow-*">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {SHADOW_TOKENS.map((name) => (
              <div
                key={name}
                className="flex h-16 items-center justify-center rounded bg-card text-13 text-ink-muted"
                style={{ boxShadow: `var(${name})` }}
              >
                {name.replace("--mg-shadow-", "")}
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="Z-index layers" caption="--mg-z-*">
          <div className="space-y-1.5">
            {Z_TOKENS.map(([name, value]) => (
              <SwatchRow
                key={name}
                label={name}
                sample={<span className="tabular-nums text-ink">{value}</span>}
              />
            ))}
          </div>
        </Panel>
        <Panel title="Radius scale" caption="rounded-* (#7843)">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {RADIUS_TOKENS.map(([cls]) => (
              <div key={cls} className="flex flex-col items-center gap-1.5 p-2">
                <span className={`size-10 border border-accent/60 bg-accent/10 ${cls}`} />
                <span className="text-13 text-ink-muted text-center">{cls}</span>
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="Glass surfaces" caption="./ ./ .">
          <div className="space-y-2">
            <div className="rounded p-3 text-13 text-ink">.</div>
            <div className="rounded p-3 text-13 text-ink">. </div>
            <div className="rounded p-3 text-13 text-ink">. </div>
          </div>
        </Panel>
      </div>

      <Section title="Chips + status">
        <div className="flex flex-wrap gap-2">
          <Chip label="kind">REST</Chip>
          <Chip tone="accent" label="curation">
            Verified
          </Chip>
          <Chip tone="ok" dot>
            Healthy
          </Chip>
          <Chip tone="warn" dot>
            Degraded
          </Chip>
          <Chip tone="down" dot>
            Down
          </Chip>
          <Chip tone="muted" label="src">
            candidate
          </Chip>
          <StatusBadge status="ok" live />
          <StatusBadge status="warn" />
          <StatusBadge status="down" />
          <StatusBadge status="unknown" />
        </div>
      </Section>

      <Section title="Indicators (grid card row)">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 rounded border border-border bg-card p-4">
          <Indicator icon={Layers} label="uids" value="128" title="Registered UIDs" />
          <Indicator icon={Server} label="surfaces" value="14" hint="of 20" />
          <Indicator icon={Radio} label="endpoints" value="7" />
          <Indicator icon={Activity} label="health" value="99.4%" title="30d probe uptime" />
        </div>
      </Section>

      <Section title="Filter toolbar + freshness + density + columns">
        <div className="rounded border border-border bg-card p-3">
          <FilterToolbar
            trailing={
              <>
                <ColumnCustomizer
                  columns={COLUMNS}
                  isVisible={cols.isVisible}
                  onToggle={cols.toggle}
                  onReset={cols.reset}
                />
              </>
            }
          >
            <FilterField label="search" htmlFor="pv-q" grow>
              <FilterInput id="pv-q" placeholder="Search netuid, name, provider…" />
            </FilterField>
            <FilterField label="kind" htmlFor="pv-kind">
              <FilterSelect id="pv-kind" defaultValue="">
                <option value="">All</option>
                <option value="rest">REST</option>
                <option value="sse">SSE</option>
                <option value="graphql">GraphQL</option>
              </FilterSelect>
            </FilterField>
            <FilterField label="curation" htmlFor="pv-cur">
              <FilterSelect id="pv-cur" defaultValue="">
                <option value="">Any</option>
                <option value="verified">Verified</option>
                <option value="candidate">Candidate</option>
              </FilterSelect>
            </FilterField>
          </FilterToolbar>
        </div>
      </Section>
    </Section>
  );
}

/* ---------- Layout ---------- */

function LayoutSection({ updated }: { updated: string }) {
  return (
    <Section id="layout" title="Layout">
      <div className="space-y-4">
        <Show name="EntityHero, FactSentence, Fact, FactStrip, LiveMeta">
          <div data-testid="hero-demo">
            <EntityHero
              crumbs={[{ label: "Subnets", href: "/subnets" }, { label: "SN19" }]}
              name="Nineteen"
              avatar={<BrandIcon size={40} name="Nineteen" fallback={19} netuid={19} />}
              action={
                <a className="mg-hero-action" href="/subnets/19">
                  Open subnet
                </a>
              }
              sentence={
                <FactSentence>
                  Ranked <Fact>#04</Fact> by emission with <Fact>4.3%</Fact> of daily emission ·{" "}
                  <Fact>247/256</Fact> UIDs · <Fact>OK</Fact> for <Fact>75d</Fact> ·{" "}
                  <Fact>application</Fact>
                </FactSentence>
              }
              cells={[
                { label: "Emission", value: "4.3%", delta: { text: "+0.2", tone: "good" } },
                { label: "Alpha price", value: "0.0722 τ", delta: { text: "−1.4%", tone: "bad" } },
                { label: "Total stake", value: "3.58M τ" },
                { label: "UIDs", value: "247/256" },
              ]}
              live={{ updatedAt: updated, source: "chain", onRefresh: () => {} }}
            />
          </div>
        </Show>
        <Show name="AnalyticsPage, AnalyticsSection, SectionNav, RangeControl">
          <div data-testid="analytics-demo">
            <AnalyticsPage>
              <AnalyticsSection
                id="demo-emission"
                name="Emission"
                question="Which subnets the chain pays, per block."
                controls={<RangeDemo />}
                visual={<div className="h-24 rounded bg-layer" aria-hidden />}
                footnote="7d · chain"
              />
              <AnalyticsSection
                id="demo-stake"
                name="Stake"
                question="Where the TAO sits."
                visual={<div className="h-24 rounded bg-layer" aria-hidden />}
                footnote="latest snapshot · registry"
              />
            </AnalyticsPage>
          </div>
        </Show>
      </div>
    </Section>
  );
}

/* ---------- Data display ---------- */

const BAR_DATA = [
  { label: "SubtensorModule", value: 399_432 },
  { label: "Drand", value: 201_572 },
  { label: "Ethereum", value: 146_714 },
];

const DONUT_DATA = [
  { label: "RPC", value: 42, color: "var(--chart-1)" },
  { label: "WSS", value: 28, color: "var(--chart-2)" },
  { label: "API", value: 18, color: "var(--chart-3)" },
  { label: "SSE", value: 12, color: "var(--chart-4)" },
];

const TREEMAP_DATA = [
  { label: "Official", value: 91, color: "var(--accent)" },
  { label: "Provider-claimed", value: 24, color: "var(--chart-2)" },
  { label: "Community", value: 14, color: "var(--ink-subtle)" },
];

const SPARK_VALUES = [12, 14, 13, 18, 22, 20, 26];
const LINE_SPECIMEN = lineSpecimen(120);
const STACKED_SPECIMEN = stackedSpecimen();
const formatTokens = (v: number) => `${v}T`;

function ChartsSection() {
  // Its own store, like EntityDemo: the specimen must work wherever the page
  // is mounted, and the three charts should cross-highlight each other.
  return (
    <ActiveEntityProvider>
      <Section id="charts" title="Charts">
        <div className="grid gap-4">
          <Show name="StackedColumns">
            <StackedColumns
              {...STACKED_SPECIMEN}
              ariaLabel="Daily emission by subnet (specimen)"
              formatValue={(v) => `${v}τ`}
            />
          </Show>
          <Show name="LineWithWindow">
            <LineWithWindow
              {...LINE_SPECIMEN}
              unit="tokens"
              formatValue={formatTokens}
              ariaLabel="Momentum specimen"
              source="line-specimen"
            />
          </Show>
          <Show name="LineWithWindow compact">
            <LineWithWindow
              {...LINE_SPECIMEN}
              compact
              unit="tokens"
              formatValue={formatTokens}
              ariaLabel="Momentum specimen, compact"
              source="line-specimen-compact"
            />
          </Show>
        </div>
      </Section>
    </ActiveEntityProvider>
  );
}

function DataDisplaySection() {
  return (
    <Section id="data-display" title="Data display">
      <div className="grid gap-4 md:grid-cols-2">
        <Show name="BarMini">
          <BarMini data={BAR_DATA} showValue formatValue={(v) => v.toLocaleString("en-US")} />
        </Show>
        <Show name="Donut, DonutLegend">
          <div className="flex items-center gap-4">
            <Donut segments={DONUT_DATA} centerLabel="100" centerSub="endpoints" />
            <DonutLegend segments={DONUT_DATA} />
          </div>
        </Show>
        <Show name="TrendDelta">
          <div className="flex items-center gap-3">
            <TrendDelta values={SPARK_VALUES} label="7d specimen" />
            <TrendDelta values={[...SPARK_VALUES].reverse()} label="7d specimen" />
            <TrendDelta values={[3, 3]} label="7d specimen" />
          </div>
        </Show>
        <Show name="TreemapMini">
          <TreemapMini data={TREEMAP_DATA} className="h-32" />
        </Show>

        <Show name="TableState">
          <div className="space-y-3">
            <TableState variant="empty" title="No rows match this filter" />
            <TableState
              variant="stale"
              title="Data may be out of date"
              generatedAt={SAMPLE_UPDATED_AT}
            />
          </div>
        </Show>
        <Show name="YieldPercentileStrip">
          <YieldPercentileStrip
            p25_yield={0.08}
            median_yield={0.12}
            p75_yield={0.16}
            p90_yield={0.21}
          />
        </Show>
      </div>

      <Section title="Panel">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Panel title="Coverage" caption="Verified public surfaces across all active netuids.">
            <div className="grid grid-cols-2 gap-3">
              <Indicator icon={Layers} label="subnets" value="129" orientation="column" />
              <Indicator icon={Server} label="surfaces" value="284" orientation="column" />
            </div>
          </Panel>
          <Panel title="Endpoint health">
            <div className="flex flex-col gap-2">
              <h3 className="text-13 font-semibold text-ink-strong">Live probes</h3>
              <div className="flex flex-wrap gap-2">
                <StatusBadge status="ok" live />
                <StatusBadge status="warn" />
                <StatusBadge status="down" />
              </div>
            </div>
          </Panel>
          <Panel title="Loading" flush>
            <TableSkeleton rows={4} columns={4} />
          </Panel>
          <Panel title="Empty state">
            <EmptyState
              variant="filtered"
              title="No surfaces match this filter"
              hint="Widen the kind filter or clear the provider constraint to see more results."
              evidenceHref={GITHUB_REPO_URL}
            />
          </Panel>
        </div>
      </Section>

      <Section title="PanelHeader">
        <Panel>
          <PanelHeader
            title="Panel header"
            description="Right-aligned actions slot, display or micro variant."
            actions={<GhostButton size="sm">Action</GhostButton>}
          />
        </Panel>
      </Section>
    </Section>
  );
}

/* ---------- Interaction ---------- */

function InteractionSection() {
  const [viewMode, setViewMode] = useState<"table" | "grid" | "matrix">("table");
  const [q, setQ] = useState("");
  const [chips, setChips] = useState([
    { id: "kind", label: "Kind", value: "REST" },
    { id: "health", label: "Health", value: "OK" },
  ]);

  return (
    <Section id="interaction" title="Interaction">
      <div className="grid gap-4 md:grid-cols-2">
        <Show name="QueryBar">
          <QueryBar ariaLabel="Design primitives filter demo">
            <QueryBar.Search value={q} onChange={setQ} placeholder="Search…" />
            <QueryBar.Divider />
            <QueryBar.FilterTrigger
              label="Health"
              value=""
              onChange={() => undefined}
              options={[
                { value: "ok", label: "OK" },
                { value: "warn", label: "Warn" },
              ]}
            />
            <QueryBar.Utility>
              <ShareButton bare />
            </QueryBar.Utility>
          </QueryBar>
        </Show>

        <Show name="ViewModeToggle">
          <ViewModeToggle value={viewMode} onChange={setViewMode} />
        </Show>
        <Show name="ShareButton">
          <div className="flex flex-wrap gap-2">
            <ShareButton />
            <div className="mg-actions">
              <ShareButton bare connected />
            </div>
          </div>
        </Show>
        <Show name="DownloadCsvButton">
          <DownloadCsvButton url="https://api.metagraph.sh/api/v1/subnets" />
        </Show>
        <Show name="CopyableCode, CopyButton, CopyIconToggle, KeyChip">
          <div className="flex flex-wrap items-center gap-3">
            <CopyableCode value="5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY" />
            <CopyButton value="copy me" label="sample" />
            <CopyIconToggle copied={false} />
            <KeyChip value="5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY" />
          </div>
        </Show>
        <Show name="ExternalLink">
          <div className="flex flex-wrap gap-3">
            <ExternalLink href="https://taostats.io">Public link</ExternalLink>
            <ExternalLink href="https://taostats.io" authRequired>
              Auth required
            </ExternalLink>
            <ExternalLink href="https://taostats.io" publicSafe>
              Public-safe
            </ExternalLink>
          </div>
        </Show>

        <Show name="FilterChipRow">
          <FilterChipRow
            items={chips}
            onRemove={(id) => setChips((c) => c.filter((x) => x.id !== id))}
            onClearAll={() => setChips([])}
          />
        </Show>
        <Show name="FilterSheet">
          <FilterSheet label="Filters" activeCount={2}>
            <label className="grid gap-1">
              <span className="text-10 text-ink-muted">Sample field</span>
              <FilterInput placeholder="…" />
            </label>
          </FilterSheet>
        </Show>

        <Show name="ScrollShadow, ResponsiveTable">
          <ResponsiveTable minWidth={480}>
            <table className="w-full text-left text-13">
              <thead>
                <tr>
                  <th className="px-3 py-1.5 text-ink-muted">Netuid</th>
                  <th className="px-3 py-1.5 text-ink-muted">Name</th>
                  <th className="px-3 py-1.5 text-ink-muted">Health</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                <tr>
                  <td className="px-3 py-1.5">1</td>
                  <td className="px-3 py-1.5">Apex</td>
                  <td className="px-3 py-1.5">OK</td>
                </tr>
              </tbody>
            </table>
          </ResponsiveTable>
          {/* ScrollShadow was imported and named in this Show's label but only
              demonstrated indirectly, via ResponsiveTable's internal use of it
              (#8294). A design-system reference should show the primitive
              itself, so here it is standalone — scroll it to see the edge fades
              appear and disappear per edge. */}
          <ScrollShadow className="mt-3">
            <div className="flex w-max items-center gap-2 py-1">
              {Array.from({ length: 24 }, (_, i) => (
                <span
                  key={i}
                  className="whitespace-nowrap rounded border border-border bg-surface px-2 py-1 text-13 text-ink-muted"
                >
                  scrollable item {i + 1}
                </span>
              ))}
            </div>
          </ScrollShadow>
        </Show>
        <Show name="ListShell, LoadMore">
          <ListShell
            filters={<FilterInput placeholder="Filter…" />}
            table={
              <table className="w-full text-left text-13">
                <thead>
                  <tr>
                    <th className="px-3 py-1.5 text-ink-muted">Netuid</th>
                    <th className="px-3 py-1.5 text-ink-muted">Health</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  <tr>
                    <td className="px-3 py-1.5">1</td>
                    <td className="px-3 py-1.5">OK</td>
                  </tr>
                </tbody>
              </table>
            }
            footer={
              <LoadMore
                hasMore
                isLoading={false}
                onLoadMore={() => undefined}
                shown={1}
                total={129}
              />
            }
          />
        </Show>
        <Show name="Kbd, Definition">
          <div className="flex flex-wrap items-center gap-4" data-testid="definition-demo">
            <span className="text-13 text-ink-muted">
              Press <Kbd>⌘</Kbd> <Kbd>K</Kbd>
            </span>
            <span className="inline-flex items-center gap-1 text-13">
              Emission share <Definition term="Emission share" />
            </span>
            <Definition term="Validator take">
              <span className="rounded border border-rule px-1.5 text-11">take 18%</span>
            </Definition>
          </div>
        </Show>
        <Show name="ActiveEntityProvider, useEntityMark, ChartTooltip">
          <EntityDemo />
        </Show>
        <Show name="Popover">
          <Popover>
            <PopoverTrigger asChild>
              <GhostButton size="sm">Open popover</GhostButton>
            </PopoverTrigger>
            <PopoverContent className="w-56 p-3 text-13">Popover content.</PopoverContent>
          </Popover>
        </Show>
        <Show name="Raw, RawCode">
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
            <RawCode label="curl">{"curl https://api.metagraph.sh/api/v1/subnets/1"}</RawCode>
          </Raw>
        </Show>
        <Show name="Dialog">
          <Dialog>
            <DialogTrigger asChild>
              <GhostButton size="sm">Open dialog</GhostButton>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Sample dialog</DialogTitle>
                <DialogDescription>Static demo content, no network dependency.</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <GhostButton size="sm">Close</GhostButton>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </Show>
        <Show name="Sheet">
          <Sheet>
            <SheetTrigger asChild>
              <GhostButton size="sm">Open sheet</GhostButton>
            </SheetTrigger>
            <SheetContent>
              <SheetHeader>
                <SheetTitle>Sample sheet</SheetTitle>
                <SheetDescription>Slide-in panel, static demo content.</SheetDescription>
              </SheetHeader>
              <SheetFooter>
                <GhostButton size="sm">Close</GhostButton>
              </SheetFooter>
            </SheetContent>
          </Sheet>
        </Show>
        <Show name="Command">
          <Command className="rounded border border-border">
            <CommandInput placeholder="Type a command…" />
            <CommandList>
              <CommandEmpty>No results.</CommandEmpty>
              <CommandGroup heading="Sample">
                <CommandItem>Item one</CommandItem>
                <CommandItem>Item two</CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </Show>
        <Show name="Accordion">
          <Accordion type="single" collapsible className="w-full">
            <AccordionItem value="a">
              <AccordionTrigger>Sample accordion item</AccordionTrigger>
              <AccordionContent>Static demo content.</AccordionContent>
            </AccordionItem>
          </Accordion>
        </Show>
      </div>
    </Section>
  );
}

/* ---------- Feedback ---------- */

function FeedbackSection({ updated }: { updated: string }) {
  return (
    <Section id="feedback" title="Feedback">
      <div className="grid gap-4 md:grid-cols-2">
        <Show name="Skeleton, PanelSkeleton, TableSkeleton">
          <div className="space-y-3">
            <Skeleton className="h-4 w-2/3" />
            <PanelSkeleton height="sm" />
          </div>
        </Show>
        <Show name="PanelError">
          <PanelError
            title="Couldn't load this panel"
            errorId="demo-1234"
            onRetry={() => undefined}
            height="sm"
          />
        </Show>
        <Show name="EmptyState">
          <div className="space-y-3">
            <EmptyState variant="filtered" title="No rows match this filter" />
            <EmptyState variant="error" title="Failed to load" />
          </div>
        </Show>
        <Show name="QueryProgress">
          <div className="relative h-6 rounded border border-border bg-card">
            <QueryProgress active position="absolute" />
          </div>
        </Show>
        <Show name="LoadingPill">
          <LoadingPill>Refreshing…</LoadingPill>
        </Show>

        <Show name="AnimatedNumber">
          <AnimatedNumber value={12_456} className="font-mono text-16 text-ink-strong" />
        </Show>
        <Show name="BackToTop">
          <p className="text-13 text-ink-muted">
            Renders a scroll-triggered "back to top" button — not shown inline since it needs page
            scroll to appear; used in every long-form detail page.
          </p>
        </Show>
        <Show name="McpToolsList">
          <McpToolsList
            tools={[{ name: "get_subnet" }, { name: "list_endpoints" }, { name: "search_subnets" }]}
          />
        </Show>
        <Show name="ReadinessGauge">
          <ReadinessGauge score={72} tier="buildable" details={["subnet-api", "docs"]} />
        </Show>
        <Show name="ProvenanceChip, CurationChip, ReviewChip, CandidateChip">
          <div className="flex flex-wrap gap-2">
            <ProvenanceChip level="native" />
            <CurationChip level="maintainer-reviewed" />
            <ReviewChip state="approved" />
            <CandidateChip />
          </div>
        </Show>
        <Show name="EligibilityChip">
          <div className="flex flex-wrap gap-2">
            <EligibilityChip eligibility="proxy-enabled" />
            <EligibilityChip eligibility="pool-member" />
          </div>
        </Show>
        <Show name="HealthDot, HealthPill">
          <div className="flex flex-wrap items-center gap-3">
            <HealthDot state="ok" />
            <HealthDot state="warn" variant="label" />
            <HealthPill state="ok" />
            <HealthPill state="down" />
          </div>
        </Show>

        <Show name="RoutePending">
          <div className="max-h-40 overflow-hidden rounded border border-border">
            <RoutePending panels={2} panelHeight="sm" />
          </div>
        </Show>

        <Show name="BrandIcon">
          <div className="flex items-center gap-3">
            <BrandIcon name="Apex" fallback={1} netuid={1} size={32} />
            <BrandIcon name="Metagraphed" fallback="M" size={32} />
          </div>
        </Show>
        <Show name="Wordmark, DiscordIcon">
          <div className="flex items-center gap-4 text-ink-strong">
            <Wordmark className="h-6" />
            <DiscordIcon className="size-5" />
          </div>
        </Show>
        <Show name="TimeAgo">
          <TimeAgo at={updated} />
        </Show>
        <Show name="Divider">
          <div className="space-y-3">
            <Divider />
            <Divider tone="accent" pip />
          </div>
        </Show>
      </div>
    </Section>
  );
}

const DEMO_KEYS = Array.from({ length: 12 }, (_, i) => `m-${i + 1}`);
const DEMO_VALUES = [42, 58, 35, 71, 64, 29, 80, 53, 47, 66, 38, 75];

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

function EntityDemo() {
  const [activated, setActivated] = useState<string>("");
  return (
    <ActiveEntityProvider>
      <div data-testid="entity-demo" className="space-y-3">
        <button type="button" data-testid="entity-demo-before" className="text-11 text-ink-muted">
          before the group
        </button>
        <div className="relative" data-marks>
          <ChartTooltip top={8} />
          <div className="flex h-32 items-end gap-1">
            {DEMO_KEYS.map((_, i) => (
              <DemoBar key={DEMO_KEYS[i]} index={i} onActivate={setActivated} />
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
