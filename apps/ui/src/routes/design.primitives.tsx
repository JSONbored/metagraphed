import { createFileRoute } from "@tanstack/react-router";
import { Activity, Layers, Radio, Server } from "lucide-react";
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
import { DensityToggle } from "@jsonbored/ui-kit";
import { useState } from "react";

export const Route = createFileRoute("/design/primitives")({
  head: () => ({
    meta: [
      { title: "Primitives · Metagraphed" },
      {
        name: "description",
        content:
          "Shared registry UI primitives: chips, status badges, filters, freshness, breadcrumbs, density, columns.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: PrimitivesPreview,
});

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

function PrimitivesPreview() {
  const [density, setDensity] = useState<"comfortable" | "compact">("comfortable");
  const cols = useColumnVisibility("primitives-preview", COLUMNS);
  const updated = new Date(Date.now() - 4 * 60 * 1000).toISOString();

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
        title="Registry primitives"
        description="Shared building blocks — chips, badges, filter toolbars, freshness pills, breadcrumbs, density and column controls — used across the subnets, surfaces, endpoints, providers, and blocks tables."
      />

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
        <p className="mt-2 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          density={density} · visible=
          {cols.visible.join(",")}
        </p>
      </Section>

      <Section title="Panel + SectionLabel (Batch B)">
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
            action={<FreshnessPill updatedAt={updated} />}
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
        </div>
      </Section>

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
            <div className="mt-4">
              <PagerFooter
                summary="Showing 1–50 of 129"
                hasPrev={false}
                hasNext
                onPrev={() => undefined}
                onNext={() => undefined}
              />
            </div>
          </Panel>
        </div>
      </Section>

      <p className="mt-10 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
        Applied on: /subnets grid cards · /endpoints card list
      </p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="mb-3 font-display text-lg font-semibold text-ink-strong">{title}</h2>
      {children}
    </section>
  );
}
