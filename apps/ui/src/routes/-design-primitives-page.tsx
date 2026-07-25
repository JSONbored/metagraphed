import { Activity, Layers, Radio, Server } from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  Breadcrumbs,
  Chip,
  ColumnCustomizer,
  DefinitionList,
  EmptyState,
  FilterField,
  FilterInput,
  FilterSelect,
  FilterToolbar,
  FreshnessPill,
  GhostButton,
  Indicator,
  LoadingPill,
  MetaStrip,
  PagerFooter,
  Panel,
  PageMasthead,
  SectionLabel,
  StatusBadge,
  StickyToolbar,
  TableSkeleton,
  useColumnVisibility,
  type ColumnDef,
} from "@/components/metagraphed/primitives";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  AccentBand,
  ActionBar,
  AnimatedNumber,
  BarMini,
  BrandIcon,
  CandidateChip,
  CandlestickMini,
  ChartSkeleton,
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
  DailyRollupFreshness,
  DensityToggle,
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
  DotRow,
  DownloadCsvButton,
  EligibilityChip,
  EntityHero,
  ExternalLink,
  FilterChipRow,
  FilterSheet,
  FreshnessIndicator,
  HealthDot,
  HealthPill,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  HoverPreview,
  InfoTooltip,
  Kbd,
  KeyChip,
  ListShell,
  LoadMore,
  McpToolsList,
  MethodologyCallout,
  MetricGrid,
  MiniRadial,
  MiniStack,
  MobileCollapse,
  NoDataSpark,
  PageActions,
  PageHero,
  PagerBar,
  PageSection,
  PanelError,
  PanelHeader,
  PanelSkeleton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  PrimaryLinksRail,
  ProvenanceChip,
  QueryBar,
  QueryProgress,
  RealtimeFreshness,
  ReadinessGauge,
  ResponsiveTable,
  ReviewChip,
  RoutePending,
  ScrollReveal,
  ScrollShadow,
  SectionAnchor,
  SectionHeading,
  SegmentedToggle,
  ShareButton,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  Skeleton,
  SparkLegend,
  Sparkline,
  StatTile,
  StatWithSpark,
  TableState,
  TabStrip,
  TimeAgo,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  TreemapMini,
  ViewModeToggle,
  Wordmark,
  YieldPercentileStrip,
} from "@jsonbored/ui-kit";

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
  const [density, setDensity] = useState<"comfortable" | "compact">("comfortable");
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
      <PageMasthead
        eyebrow="Design system"
        title="Design primitives"
        description="The complete Bone & Ink vocabulary — every value exported from @jsonbored/ui-kit's public barrel, plus apps/ui's own router/query-coupled wrappers. Static sample data only; this page renders with zero network dependencies."
      />

      <TabNav />

      <TokensSection density={density} setDensity={setDensity} cols={cols} updated={updated} />
      <LayoutSection updated={updated} />
      <DataDisplaySection />
      <InteractionSection density={density} setDensity={setDensity} />
      <FeedbackSection updated={updated} />

      <p className="mt-10 mg-type-micro text-ink-muted">
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
  { id: "interaction", label: "Interaction" },
  { id: "feedback", label: "Feedback" },
] as const;

function TabNav() {
  return (
    <nav
      aria-label="Design primitives sections"
      className="sticky top-0 z-[var(--mg-z-sticky)] -mx-4 mb-2 flex gap-1 overflow-x-auto border-b border-border bg-paper/92 px-4 py-2 backdrop-blur md:mx-0 md:px-0"
    >
      {NAV_SECTIONS.map((s) => (
        <a
          key={s.id}
          href={`#${s.id}`}
          className="shrink-0 rounded px-2.5 py-1 mg-type-label uppercase text-ink-muted hover:bg-surface hover:text-ink-strong"
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
      <div className="mg-type-micro text-ink-muted">{name}</div>
      <div>{children}</div>
      <CopyableCode value={`import { ${name} } from "${from}";`} truncate={false} />
    </div>
  );
}

function Section({ title, children, id }: { title: string; children: ReactNode; id?: string }) {
  return (
    <section id={id} className="mt-10 scroll-mt-24">
      <h2 className="mb-3 font-display text-lg font-semibold text-ink-strong">{title}</h2>
      {children}
    </section>
  );
}

function SwatchRow({ label, sample }: { label: string; sample: ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded border border-border bg-card px-3 py-2">
      <span className="w-28 shrink-0 font-mono mg-type-data-sm text-ink-muted">{label}</span>
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
  ["mg-type-micro", "10px micro label"],
  ["mg-type-label", "11px uppercase label"],
  ["mg-type-caption", "12px caption"],
  ["mg-type-caption-lg", "13px caption"],
  ["mg-type-data-sm", "12px tabular data"],
  ["mg-type-data", "13px tabular data"],
] as const;

const SHADOW_TOKENS = [
  "--mg-shadow-hairline",
  "--mg-shadow-hairline-inset",
  "--mg-shadow-pop",
  "--mg-shadow-drawer",
  "--mg-shadow-pill",
  "--mg-shadow-pill-active",
  "--mg-shadow-ring-accent",
] as const;

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
  ["rounded-full", "pills, badges, avatars"],
  ["rounded", "inputs, buttons, chips"],
  ["rounded-md", "cards, popovers"],
  ["rounded-xl", "drawers, modals, sheets"],
  ["rounded-2xl", "hero tiles, mg-card-glow panels"],
] as const;

function TokensSection({
  density,
  setDensity,
  cols,
  updated,
}: {
  density: "comfortable" | "compact";
  setDensity: (d: "comfortable" | "compact") => void;
  cols: ReturnType<typeof useColumnVisibility>;
  updated: string;
}) {
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
                    className="block h-3 rounded-sm bg-accent/70"
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
                className="flex h-16 items-center justify-center rounded bg-card mg-type-micro text-ink-muted"
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
            {RADIUS_TOKENS.map(([cls, desc]) => (
              <div key={cls} className="flex flex-col items-center gap-1.5 p-2">
                <span className={`size-10 border border-accent/60 bg-accent/10 ${cls}`} />
                <span className="mg-type-micro text-ink-muted text-center">{cls}</span>
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="Glass surfaces" caption=".mg-glass / .mg-glass-soft">
          <div className="space-y-2">
            <div className="mg-glass rounded-md p-3 mg-type-caption text-ink">.mg-glass</div>
            <div className="mg-glass-soft rounded-md p-3 mg-type-caption text-ink">
              .mg-glass-soft
            </div>
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
                <FreshnessPill updatedAt={updated} windowLabel="24h" />
                <DensityToggle value={density} onChange={setDensity} />
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
        <Show name="PageHero">
          <PageHero
            eyebrow="Explorer"
            live
            title="PageHero sample"
            description="Blockmachine-style hero with a hairline KPI strip and a top-right mono caption."
            kpis={[
              { label: "subnets", value: "129" },
              { label: "surfaces", value: "3,101" },
            ]}
            className="!mb-0 !pt-6 !pb-6"
          />
        </Show>
        <Show name="EntityHero">
          <EntityHero
            eyebrow="Account"
            title="5Grw…tQY"
            subtitle="ss58 address"
            description="Compact-size entity hero used on account/validator detail pages."
            stats={[
              { label: "events", value: "1,204" },
              { label: "subnets", value: "6" },
            ]}
            size="compact"
          />
        </Show>
        <Show name="PageSection">
          <PageSection
            id="ds-page-section"
            eyebrow="Coverage"
            title="PageSection sample"
            description="Canonical section header — hairline, eyebrow, oversized H2, optional description/actions/toolbar."
          >
            <p className="mg-type-caption text-ink-muted">Section body content goes here.</p>
          </PageSection>
        </Show>
        <Show name="AccentBand">
          <AccentBand pattern>
            <p className="mg-type-caption text-ink">
              Mint-accent band, optional dot pattern overlay.
            </p>
          </AccentBand>
        </Show>
        <Show name="SectionAnchor">
          <SectionAnchor
            id="ds-section-anchor"
            title="SectionAnchor sample"
            subtitle="Copyable #hash link, optional accent rail and info tooltip."
            info="Explains what this section shows."
            tone="accent"
          >
            <p className="mg-type-caption text-ink-muted">
              Section content, deep-linkable via #ds-section-anchor.
            </p>
          </SectionAnchor>
        </Show>
        <Show name="SectionHeading">
          <SectionHeading
            title="SectionHeading sample"
            intro="Lighter-weight heading than PageSection — no hairline, no toolbar row."
            right={<FreshnessPill updatedAt={updated} />}
          />
        </Show>
        <Show name="ScrollReveal">
          <ScrollReveal>
            <p className="mg-type-caption text-ink-muted">
              Fades/slides in on scroll-into-view (honors prefers-reduced-motion).
            </p>
          </ScrollReveal>
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

const CANDLE_DATA = [
  { label: "Mon", open: 0.052, high: 0.058, low: 0.05, close: 0.056 },
  { label: "Tue", open: 0.056, high: 0.06, low: 0.054, close: 0.055 },
  { label: "Wed", open: 0.055, high: 0.057, low: 0.049, close: 0.05 },
  { label: "Thu", open: 0.05, high: 0.061, low: 0.05, close: 0.059 },
];

const TREEMAP_DATA = [
  { label: "Official", value: 91, color: "var(--accent)" },
  { label: "Provider-claimed", value: 24, color: "var(--chart-2)" },
  { label: "Community", value: 14, color: "var(--ink-subtle)" },
];

const SPARK_POINTS = [12, 14, 13, 18, 22, 20, 26].map((v, i) => ({ t: `d${i}`, v }));

function DataDisplaySection() {
  return (
    <Section id="data-display" title="Data display">
      <div className="grid gap-4 md:grid-cols-2">
        <Show name="StatTile">
          <div className="grid grid-cols-2 gap-3">
            <StatTile icon={Activity} eyebrow="Uptime" value="99.4%" hint="30d" tone="ok" />
            <StatTile icon={Layers} eyebrow="Surfaces" value="3,101" tone="accent" />
          </div>
        </Show>
        <Show name="StatWithSpark, MiniStack, MiniRadial, DotRow, NoDataSpark">
          <div className="space-y-3">
            <StatWithSpark
              label="Total stake"
              value="344.36M τ"
              hint="network-wide"
              tone="ok"
              viz={<Sparkline values={SPARK_POINTS.map((p) => p.v)} width={64} height={24} />}
            />
            <MiniStack
              segments={[
                { label: "ok", value: 558, color: "var(--health-ok)" },
                { label: "warn", value: 41, color: "var(--health-warn)" },
                { label: "down", value: 18, color: "var(--health-down)" },
              ]}
            />
            <div className="flex items-center gap-3">
              <MiniRadial value={0.72} />
              <DotRow
                dots={[
                  { label: "api", on: true },
                  { label: "sse", on: false },
                  { label: "docs", on: true },
                ]}
              />
            </div>
            <NoDataSpark />
          </div>
        </Show>
        <Show name="BarMini">
          <BarMini data={BAR_DATA} showValue formatValue={(v) => v.toLocaleString()} />
        </Show>
        <Show name="Donut, DonutLegend">
          <div className="flex items-center gap-4">
            <Donut segments={DONUT_DATA} centerLabel="100" centerSub="endpoints" />
            <DonutLegend segments={DONUT_DATA} />
          </div>
        </Show>
        <Show name="Sparkline">
          <Sparkline
            values={SPARK_POINTS.map((p) => p.v)}
            points={SPARK_POINTS}
            width={200}
            height={40}
          />
        </Show>
        <Show name="SparkLegend">
          <SparkLegend
            metric="Health trend"
            source="Live probe series, sample data."
            windowLabel="7d"
            side="top"
          >
            <Sparkline values={SPARK_POINTS.map((p) => p.v)} width={120} height={28} />
          </SparkLegend>
        </Show>
        <Show name="CandlestickMini">
          <CandlestickMini data={CANDLE_DATA} width={280} height={120} />
        </Show>
        <Show name="TreemapMini">
          <TreemapMini data={TREEMAP_DATA} className="h-32" />
        </Show>
        <Show name="MetricGrid">
          <MetricGrid cols={{ base: 2, md: 3 }} gap="sm">
            <StatTile icon={Server} eyebrow="Endpoints" value="47" />
            <StatTile icon={Radio} eyebrow="Live" value="44" tone="ok" />
            <StatTile icon={Layers} eyebrow="Kinds" value="8" />
          </MetricGrid>
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

      <Section title="Panel + SectionLabel">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Panel title="Coverage" caption="Verified public surfaces across all active netuids.">
            <div className="grid grid-cols-2 gap-3">
              <Indicator icon={Layers} label="subnets" value="129" orientation="column" />
              <Indicator icon={Server} label="surfaces" value="284" orientation="column" />
            </div>
          </Panel>
          <Panel
            title="Endpoint health"
            tone="accent"
            action={<FreshnessPill updatedAt={SAMPLE_UPDATED_AT} />}
          >
            <div className="flex flex-col gap-2">
              <SectionLabel size="label" tone="accent">
                Live probes
              </SectionLabel>
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
              evidenceHref="https://github.com/JSONbored/metagraphed"
            />
          </Panel>
          <Panel
            title="Ok tone"
            tone="ok"
            id="design-primitives-ok-tone-panel"
            aria-label="Healthy status summary"
          >
            <StatusBadge status="ok" live />
            <p className="mt-2 mg-type-caption text-ink-muted">
              tone="ok" — tinted border + background. id/aria-label above land on the outer element
              via rest-prop forwarding.
            </p>
          </Panel>
          <Panel title="Border-only tint" tone="warn" tintBorderOnly>
            <p className="mg-type-caption text-ink-muted">
              tintBorderOnly keeps the warn border but skips the tinted fill — bg-card instead.
            </p>
          </Panel>
          <Panel title="Glow" glow>
            <p className="mg-type-caption text-ink-muted">
              glow appends the existing --mg-card-glow soft-elevation shadow (accent tone picks
              --mg-card-glow-accent automatically).
            </p>
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

function InteractionSection({
  density,
  setDensity,
}: {
  density: "comfortable" | "compact";
  setDensity: (d: "comfortable" | "compact") => void;
}) {
  const [viewMode, setViewMode] = useState<"table" | "grid" | "matrix">("table");
  const [tab, setTab] = useState<"overview" | "activity">("overview");
  const [seg, setSeg] = useState<"7d" | "30d">("7d");
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
        <Show name="SegmentedToggle">
          <SegmentedToggle
            options={[
              { value: "7d", label: "7d" },
              { value: "30d", label: "30d" },
            ]}
            value={seg}
            onChange={setSeg}
            ariaLabel="Window"
          />
        </Show>
        <Show name="TabStrip">
          <TabStrip
            items={[
              { id: "overview", label: "Overview" },
              { id: "activity", label: "Activity", meta: 12 },
            ]}
            value={tab}
            onChange={setTab}
            ariaLabel="Design primitives tabs"
          />
        </Show>
        <Show name="ViewModeToggle">
          <ViewModeToggle value={viewMode} onChange={setViewMode} />
        </Show>
        <Show name="ShareButton">
          <div className="flex flex-wrap gap-2">
            <ShareButton />
            <ActionBar>
              <ShareButton bare connected />
            </ActionBar>
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
        <Show name="ActionBar, PagerBar, PagerFooter">
          <div className="space-y-3">
            <ActionBar>
              <GhostButton size="sm">A</GhostButton>
              <GhostButton size="sm">B</GhostButton>
            </ActionBar>
            <PagerBar hasPrev={false} hasNext onPrev={() => undefined} onNext={() => undefined} />
            <PagerFooter
              summary="Showing 1–50 of 129"
              hasPrev={false}
              hasNext
              onPrev={() => undefined}
              onNext={() => undefined}
            />
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
              <span className="mg-label">Sample field</span>
              <FilterInput placeholder="…" />
            </label>
          </FilterSheet>
        </Show>
        <Show name="PageActions">
          <PageActions
            primary={<GhostButton tone="accent">Primary</GhostButton>}
            secondary={
              <>
                <GhostButton>Secondary A</GhostButton>
                <GhostButton>Secondary B</GhostButton>
              </>
            }
          />
        </Show>
        <Show name="ScrollShadow, ResponsiveTable">
          <ResponsiveTable minWidth={480}>
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th className="px-3 py-1.5 mg-type-micro text-ink-muted">Netuid</th>
                  <th className="px-3 py-1.5 mg-type-micro text-ink-muted">Name</th>
                  <th className="px-3 py-1.5 mg-type-micro text-ink-muted">Health</th>
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
        </Show>
        <Show name="ListShell, LoadMore">
          <ListShell
            filters={<FilterInput placeholder="Filter…" />}
            table={
              <table className="w-full text-left text-sm">
                <thead>
                  <tr>
                    <th className="px-3 py-1.5 mg-type-micro text-ink-muted">Netuid</th>
                    <th className="px-3 py-1.5 mg-type-micro text-ink-muted">Health</th>
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
        <Show name="Kbd, InfoTooltip, HoverPreview">
          <div className="flex flex-wrap items-center gap-4">
            <span className="mg-type-caption text-ink-muted">
              Press <Kbd>⌘</Kbd> <Kbd>K</Kbd>
            </span>
            <InfoTooltip label="Explains what this metric means." />
            <HoverPreview
              content={<span className="mg-type-caption">Preview content on hover/focus.</span>}
            >
              <span tabIndex={0} className="cursor-default underline decoration-dotted">
                Hover me
              </span>
            </HoverPreview>
          </div>
        </Show>
        <Show name="Tooltip">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <GhostButton size="sm">Hover</GhostButton>
              </TooltipTrigger>
              <TooltipContent>Radix tooltip content</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </Show>
        <Show name="Popover">
          <Popover>
            <PopoverTrigger asChild>
              <GhostButton size="sm">Open popover</GhostButton>
            </PopoverTrigger>
            <PopoverContent className="w-56 p-3 mg-type-caption">Popover content.</PopoverContent>
          </Popover>
        </Show>
        <Show name="HoverCard">
          <HoverCard>
            <HoverCardTrigger asChild>
              <GhostButton size="sm">Hover card</GhostButton>
            </HoverCardTrigger>
            <HoverCardContent className="w-56 mg-type-caption">
              Hover card content.
            </HoverCardContent>
          </HoverCard>
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
          <Command className="rounded-md border border-border">
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

      <Section title="Batch D — toolbars, metadata, actions">
        <div className="grid gap-4 md:grid-cols-2">
          <Panel title="Sticky toolbar" flush>
            <StickyToolbar offset={0} hairline={false} className="!static">
              <FilterInput value="" onChange={() => undefined} placeholder="Filter…" />
              <GhostButton>Reset</GhostButton>
              <LoadingPill>Refreshing</LoadingPill>
            </StickyToolbar>
          </Panel>
          <Panel title="Ghost buttons">
            <div className="flex flex-wrap gap-2">
              <GhostButton>Default</GhostButton>
              <GhostButton tone="accent">Accent</GhostButton>
              <GhostButton tone="warn">Warn</GhostButton>
              <GhostButton tone="down">Down</GhostButton>
              <GhostButton size="md">Medium</GhostButton>
            </div>
          </Panel>
          <Panel title="Definition list">
            <DefinitionList
              items={[
                { term: "Netuid", detail: "7" },
                { term: "Provider", detail: "Allways" },
                { term: "Endpoints", detail: "12" },
                { term: "Health", detail: "OK" },
              ]}
            />
          </Panel>
          <Panel title="Meta strip · Pager footer">
            <MetaStrip
              items={[
                { label: "Rows", value: "129" },
                { label: "Kinds", value: "6" },
                { label: "Updated", value: "2m ago" },
              ]}
            />
          </Panel>
          <Panel title="Density toggle">
            <DensityToggle value={density} onChange={setDensity} />
          </Panel>
          <Panel title="PrimaryLinksRail">
            <PrimaryLinksRail
              website="https://taostats.io"
              docs="https://taostats.io"
              repo="https://github.com"
            />
          </Panel>
        </div>
      </Section>
    </Section>
  );
}

/* ---------- Feedback ---------- */

function FeedbackSection({ updated }: { updated: string }) {
  return (
    <Section id="feedback" title="Feedback">
      <div className="grid gap-4 md:grid-cols-2">
        <Show name="Skeleton, ChartSkeleton, PanelSkeleton, TableSkeleton">
          <div className="space-y-3">
            <Skeleton className="h-4 w-2/3" />
            <ChartSkeleton height={48} />
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
        <Show name="FreshnessIndicator, DailyRollupFreshness, RealtimeFreshness, FreshnessPill">
          <div className="flex flex-wrap items-center gap-3">
            <FreshnessIndicator at={updated} />
            <DailyRollupFreshness at={updated} />
            <RealtimeFreshness at={updated} />
            <FreshnessPill updatedAt={updated} />
          </div>
        </Show>
        <Show name="AnimatedNumber">
          <AnimatedNumber value={12_456} className="font-mono text-lg text-ink-strong" />
        </Show>
        <Show name="BackToTop">
          <p className="mg-type-caption text-ink-muted">
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
        <Show name="MethodologyCallout">
          <MethodologyCallout generatedAt={updated} windowLabel="7d" />
        </Show>
        <Show name="RoutePending">
          <div className="max-h-40 overflow-hidden rounded border border-border">
            <RoutePending panels={2} panelHeight="sm" />
          </div>
        </Show>
        <Show name="MobileCollapse">
          <MobileCollapse label="Sample section" hint="tap to expand">
            <p className="mg-type-caption text-ink-muted">
              Collapsed content, mobile-only trigger.
            </p>
          </MobileCollapse>
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
