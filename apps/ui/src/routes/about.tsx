import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  Github,
  ArrowUpRight,
  FileCode2,
  Network as NetworkIcon,
  Activity,
  Clock,
} from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { CopyableCode, ExternalLink } from "@jsonbored/ui-kit";
import { PageMasthead, Panel } from "@/components/metagraphed/primitives";
import { API_BASE, GITHUB_REPO } from "@/lib/metagraphed/config";
import { coverageQuery, freshnessQuery, healthQuery } from "@/lib/metagraphed/queries";
import { formatNumber, humaniseSeconds } from "@/lib/metagraphed/format";
import { Skeleton, StatUnavailable } from "@/components/metagraphed/states";
import { statPhase, type StatPhase } from "@/lib/metagraphed/stat-phase";

export const Route = createFileRoute("/about")({
  head: () => ({
    meta: [
      { title: "About — Metagraphed" },
      {
        name: "description",
        content:
          "Methodology, scope, and contribution model for Metagraphed — the unofficial Bittensor explorer and integration registry.",
      },
    ],
  }),
  component: AboutPage,
});

function AboutPage() {
  return (
    <AppShell>
      <PageMasthead
        eyebrow="About"
        title="Methodology & scope"
        description="An unofficial, public explorer and integration registry for Bittensor — blocks, subnets, validators, and accounts alongside the public interfaces each subnet exposes, all machine-readable for developers and AI agents."
        actions={
          <a
            href={GITHUB_REPO}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-full bg-ink-strong px-4 py-2 text-sm font-medium text-paper hover:opacity-90 transition-opacity"
          >
            <Github className="size-3.5" /> View on GitHub
            <ArrowUpRight className="size-3.5" />
          </a>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-8 min-w-0">
          <Section title="What this is">
            <p>
              An unofficial, public explorer and integration registry for Bittensor. The explorer
              reads chain-direct data — blocks, subnets, validators, and accounts — with endpoint
              health, schema drift, and freshness. The registry maps every public interface a subnet
              exposes — APIs, OpenAPI schemas, docs, repos, SSE streams, data artifacts, and
              providers — with source evidence and the curation gaps still to fill. Everything is
              machine-readable, served over REST, GraphQL, and MCP for developers and AI agents
              alike.
            </p>
          </Section>
          <Section title="What this is not">
            <ul className="list-disc pl-5 space-y-1.5">
              <li>
                Not an OpenTensor or Bittensor Foundation product — an independent, unofficial
                project.
              </li>
              <li>
                Not a custodial wallet or exchange — non-custodial by design: your keys and funds
                never leave your own wallet, and any signing stays local, never on our servers.
              </li>
              <li>No private keys, PATs, or token-gated data are ever requested or displayed.</li>
              <li>Endpoint pool eligibility is metadata only — proxy routing is future-scoped.</li>
            </ul>
          </Section>
          <Section title="Curation levels">
            <dl className="grid gap-2.5">
              <Term name="Native" desc="Sourced directly from the Bittensor chain." />
              <Term
                name="Candidate-discovered"
                desc="Leads from public sources, not yet verified."
              />
              <Term
                name="Machine-verified"
                desc="Reachable and shape-checked by automated probes."
              />
              <Term name="Maintainer-reviewed" desc="A human reviewer accepted the overlay." />
              <Term
                name="Adapter-backed"
                desc="A typed adapter publishes live metrics (e.g. SN7, SN74)."
              />
            </dl>
          </Section>
          <Section title="Coverage levels">
            <dl className="grid gap-2.5">
              <Term name="Native-only" desc="Chain identity present, no curated overlay yet." />
              <Term name="Manifested" desc="Curated overlay with at least one public surface." />
              <Term
                name="Probed"
                desc="Surfaces or endpoints actively probed for health and freshness."
              />
            </dl>
          </Section>
          <Section title="Contributing">
            <p>
              Corrections, new candidate leads, and maintainer review happen through the public
              repository. There is no in-app submission flow — registry truth lives in version
              control, reviewed in the open.
            </p>
            <div className="mt-3">
              <ExternalLink href={GITHUB_REPO}>{GITHUB_REPO}</ExternalLink>
            </div>
          </Section>
          <Section title="API & artifacts">
            <p className="mb-3">
              JSON Schema is canonical; OpenAPI and the typed clients are projections of it. Every
              public list and detail view is reachable over REST, GraphQL, and MCP — or as a static
              JSON artifact — so a human, a script, or an agent all read the same data.
            </p>
            <div className="space-y-2">
              <CopyableCode
                label="REST"
                value={`${API_BASE}/api/v1`}
                truncate={false}
                className="w-full"
              />
              <CopyableCode
                label="GraphQL"
                value={`${API_BASE}/api/v1/graphql`}
                truncate={false}
                className="w-full"
              />
              <CopyableCode
                label="MCP"
                value={`${API_BASE}/mcp`}
                truncate={false}
                className="w-full"
              />
              <CopyableCode
                label="OpenAPI"
                value={`${API_BASE}/api/v1/openapi.json`}
                truncate={false}
                className="w-full"
              />
              <CopyableCode
                label="Artifacts"
                value={`${API_BASE}/metagraph/`}
                truncate={false}
                className="w-full"
              />
            </div>
          </Section>
        </div>

        <aside className="lg:sticky lg:top-24 h-fit">
          <AtAGlance />
        </aside>
      </div>
      <ApiSourceFooter paths={["/api/v1", "/api/v1/openapi.json", "/api/v1/build"]} />
    </AppShell>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-ink-strong mb-2">
        {title}
      </h2>
      <div className="text-sm leading-relaxed text-ink space-y-2">{children}</div>
    </section>
  );
}

function Term({ name, desc }: { name: string; desc: string }) {
  return (
    <div className="grid grid-cols-[auto_1fr] gap-3 items-baseline">
      <dt className="font-mono text-[11px] uppercase tracking-widest text-ink-strong whitespace-nowrap">
        {name}
      </dt>
      <dd className="text-sm text-ink-muted">{desc}</dd>
    </div>
  );
}

function AtAGlance() {
  // Track each source query's own loading/error state so the sidebar can
  // distinguish "still loading" (skeleton) and "failed" (error glyph) from a
  // legitimately-null value ("—"), instead of collapsing all three to a dash.
  const coverageResult = useQuery(coverageQuery());
  const freshnessResult = useQuery(freshnessQuery());
  const healthResult = useQuery(healthQuery());
  const coverageRaw = (coverageResult.data?.data ?? {}) as Record<string, unknown>;
  const coverage = coverageRaw as Record<string, number | undefined>;
  const freshness = (freshnessResult.data?.data ?? {}) as Record<string, number | undefined>;
  const health = (healthResult.data?.data ?? {}) as Record<string, number | undefined>;
  // The accurate adapter-backed count is curation_level_counts['adapter-backed']
  // (=2). coverage.adapter_backed does not exist; the old fallback path could
  // surface first_party_subnet_count (73), which is a different metric.
  const curationCounts = (coverageRaw.curation_level_counts ?? {}) as Record<string, number>;
  const adapterBacked = curationCounts["adapter-backed"];
  const stats: Array<{
    icon: React.ElementType;
    label: string;
    value: string;
    to: string;
    phase: StatPhase;
  }> = [
    {
      icon: NetworkIcon,
      label: "Active subnets",
      value: coverage.netuids_active != null ? formatNumber(coverage.netuids_active) : "—",
      to: "/subnets",
      phase: statPhase(coverageResult),
    },
    {
      icon: FileCode2,
      label: "Adapter-backed",
      value: adapterBacked != null ? formatNumber(adapterBacked) : "—",
      to: "/providers",
      phase: statPhase(coverageResult),
    },
    {
      icon: Activity,
      label: "Healthy",
      value: health.ok != null && health.total ? `${health.ok}/${health.total}` : "—",
      to: "/health",
      phase: statPhase(healthResult),
    },
    {
      icon: Clock,
      label: "Avg freshness",
      value: freshness.avg_age_seconds != null ? humaniseSeconds(freshness.avg_age_seconds) : "—",
      to: "/health",
      phase: statPhase(freshnessResult),
    },
  ];
  return (
    <Panel as="div" dense>
      <div className="mg-label mb-3 inline-flex items-center gap-2">
        <span className="mg-live-dot" /> At a glance
      </div>
      <ul className="space-y-2.5">
        {stats.map(({ icon: Icon, label, value, to, phase }) => (
          <li key={label}>
            <Link
              to={to}
              className="group flex items-center gap-3 rounded-lg border border-transparent hover:border-border hover:bg-surface/40 px-2 py-1.5 -mx-2 transition-colors"
            >
              <span className="inline-flex size-7 items-center justify-center rounded-md bg-surface/70 text-ink shrink-0">
                <Icon className="size-3.5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="mg-label">{label}</div>
                <div className="font-display text-base font-semibold text-ink-strong tabular-nums">
                  {phase === "pending" ? (
                    <Skeleton className="mt-1 h-4 w-16" />
                  ) : phase === "error" ? (
                    <StatUnavailable />
                  ) : (
                    value
                  )}
                </div>
              </div>
              <ArrowUpRight className="size-3.5 text-ink-muted group-hover:text-ink-strong group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-all" />
            </Link>
          </li>
        ))}
      </ul>
      <div className="mt-4 border-t border-border pt-3 grid gap-1.5">
        <Link
          to="/schemas"
          className="font-mono text-[11px] text-ink-muted hover:text-ink-strong inline-flex items-center gap-1"
        >
          → API & schemas
        </Link>
        <Link
          to="/gaps"
          className="font-mono text-[11px] text-ink-muted hover:text-ink-strong inline-flex items-center gap-1"
        >
          → Registry gaps
        </Link>
      </div>
    </Panel>
  );
}
