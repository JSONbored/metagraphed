import { useSuspenseQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { z } from "zod";
import { ChevronDown, Download } from "lucide-react";
import { EmptyState, Skeleton } from "@/components/metagraphed/states";
import { AsyncPanel } from "@/components/metagraphed/primitives";
import { RegistryLeaderboards } from "@/components/metagraphed/registry-leaderboards";
import { RouterLink } from "@/components/metagraphed/router-link";
import {
  BrandIcon,
  DataTable,
  TimeAgo,
  Popover,
  PopoverTrigger,
  PopoverContent,
  buildCsvDownloadUrl,
  FactStrip,
  FactCell,
} from "@jsonbored/ui-kit";
import {
  chainDeregistrationsQuery,
  chainWeightsQuery,
  economicsQuery,
  metagraphedQueryKey,
  subnetsQuery,
} from "@/lib/metagraphed/queries";
import { formatNumber } from "@/lib/metagraphed/format";
import { buildUrl } from "@/lib/metagraphed/client";
import type { Subnet, SubnetEconomics } from "@/lib/metagraphed/types";
import type { leaderboardsSearchSchema } from "./leaderboards";

type LeaderboardWindow = z.infer<typeof leaderboardsSearchSchema>["window"];

const WINDOW_BTN_ACTIVE =
  "rounded border border-accent/40 bg-accent/10 px-3 py-1 text-11 text-accent-text";
const WINDOW_BTN =
  "rounded border border-border bg-card px-3 py-1 text-11 text-ink-muted hover:border-ink/30";

// Shaped to each board's own layout -- title, one description line, the
// 3-cell FactStrip, and a table-shaped placeholder -- so the loading
// state doesn't visibly jump in height/columns once the real content
// resolves (#6388). All three boards on this route share this exact shape,
// so one skeleton covers all three Suspense fallbacks.
function LeaderboardSkeleton() {
  return (
    <div className="space-y-4">
      <div>
        <Skeleton className="h-3 w-48 mb-2" />
        <Skeleton className="h-4 w-full max-w-lg" />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

// The registry-leaderboards section is a card grid (two groups of boards), a
// different shape from the FactStrip+table chain boards, so it gets its own
// matching skeleton rather than borrowing LeaderboardSkeleton.
function RegistryLeaderboardsSkeleton() {
  return (
    <div className="space-y-8">
      <div>
        <Skeleton className="h-3 w-24 mb-2" />
        <Skeleton className="h-7 w-72 mb-2" />
        <Skeleton className="h-4 w-full max-w-lg" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-56" />
        ))}
      </div>
    </div>
  );
}

// Every chain board on this route ranks the same 7d/30d window, so the window control lives at the
// page level and governs those sections rather than each board owning a duplicate toggle. The
// registry-leaderboards section is not windowed and renders independently of it.
/**
 * The boards themselves, with no page shell — so both the retiring
 * /leaderboards route and the /subnets "Rankings" section render exactly the
 * same content rather than drifting into two copies (#8311).
 */
export function LeaderboardsSection({
  win,
  onWindowChange,
}: {
  win: LeaderboardWindow;
  onWindowChange: (w: LeaderboardWindow) => void;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="text-11 text-ink-muted">Window</span>
        {(["7d", "30d"] as const).map((w) => (
          <button
            key={w}
            type="button"
            onClick={() => onWindowChange(w)}
            className={w === win ? WINDOW_BTN_ACTIVE : WINDOW_BTN}
          >
            {w}
          </button>
        ))}
      </div>
      <div className="space-y-12">
        <AsyncPanel
          context="registry leaderboards"
          fallback={<RegistryLeaderboardsSkeleton />}
          retryQueryKeys={[metagraphedQueryKey("registry-leaderboards")]}
        >
          <RegistryLeaderboards />
        </AsyncPanel>
        <AsyncPanel
          context="weight-setting activity"
          fallback={<LeaderboardSkeleton />}
          retryQueryKeys={[metagraphedQueryKey("chain-weights"), metagraphedQueryKey("subnets")]}
        >
          <WeightSettingLeaderboard win={win} />
        </AsyncPanel>
        <AsyncPanel
          context="deregistrations"
          fallback={<LeaderboardSkeleton />}
          retryQueryKeys={[
            metagraphedQueryKey("chain-deregistrations"),
            metagraphedQueryKey("subnets"),
          ]}
        >
          <DeregistrationsLeaderboard win={win} />
        </AsyncPanel>
        <AsyncPanel
          context="top emitters"
          fallback={<LeaderboardSkeleton />}
          retryQueryKeys={[metagraphedQueryKey("economics"), metagraphedQueryKey("subnets")]}
        >
          <EmissionsLeaderboard />
        </AsyncPanel>
      </div>
    </>
  );
}

/** CSV export for the boards, re-exported so the hosting page can place it. */
export { CsvExportMenu as LeaderboardsCsvExportMenu };

// Three boards, three CSV sources (#6577). A third bare CSV download button
// here collapses to an unlabeled icon below `sm` — two prior PR attempts both
// did exactly that and were rejected by the maintainer ("3 repeating icons" /
// "utterly ridiculous and confusing" on mobile, since nothing distinguishes one
// download icon from another once the text label drops). One trigger opening a
// menu of the three exports keeps the action bar to a single icon at every
// viewport, mirroring HeaderActionsMenu's single-icon-opens-a-list-of-actions
// Popover idiom (apps/ui/src/components/metagraphed/header-actions-menu.tsx) —
// each export's own label stays visible inside the open menu regardless of width.
function CsvExportMenu({ win }: { win: LeaderboardWindow }) {
  const [open, setOpen] = useState(false);
  const exports = [
    {
      label: "Weight-setting CSV",
      url: buildUrl("/api/v1/chain/weights", { window: win }),
    },
    {
      label: "Deregistrations CSV",
      url: buildUrl("/api/v1/chain/deregistrations", { window: win }),
    },
    // Not window-scoped -- EmissionsLeaderboard sources from economicsQuery(),
    // which takes no window param (/api/v1/economics?window=… is a 400).
    { label: "Emissions CSV", url: buildUrl("/api/v1/economics") },
  ];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Download CSV"
          className="inline-flex items-center gap-1.5 rounded px-2 py-1 min-h-8 text-13 font-medium text-ink-muted hover:text-ink-strong hover:bg-surface transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Download className="size-3" aria-hidden />
          <span className="hidden sm:inline">Download CSV</span>
          <ChevronDown className="size-3" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-1.5 space-y-0.5">
        {exports.map((exp) => (
          <button
            key={exp.label}
            type="button"
            onClick={() => {
              setOpen(false);
              window.location.href = buildCsvDownloadUrl(exp.url);
            }}
            className="w-full flex items-center gap-2 rounded px-2 py-2 text-left text-13 text-ink hover:bg-surface hover:text-ink-strong transition-colors min-h-9"
          >
            <Download className="size-3.5 shrink-0 text-ink-muted" aria-hidden />
            <span>{exp.label}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

// Shared subnet lookup so a board row can render the brand icon + name for its netuid. subnetsQuery
// is cached per key, so both boards mounting it is a single shared fetch, not a waterfall.
function useSubnetById(): Map<number, Subnet> {
  const { data: snRes } = useSuspenseQuery(subnetsQuery());
  return useMemo(() => {
    const m = new Map<number, Subnet>();
    for (const s of (snRes.data ?? []) as Subnet[]) m.set(s.netuid, s);
    return m;
  }, [snRes]);
}

/**
 * The subnet identity cell every board on this route shares — brand icon plus
 * name, with the row's own link supplied by `rowHref`.
 */
function SubnetIdentity({
  subnet,
  netuid,
  fallbackName,
}: {
  subnet?: Subnet;
  netuid: number;
  fallbackName?: string;
}) {
  const name = subnet?.name ?? fallbackName ?? `Subnet ${netuid}`;
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <BrandIcon
        size={18}
        name={name}
        fallback={netuid}
        netuid={netuid}
        subnetSlug={typeof subnet?.slug === "string" ? subnet.slug : undefined}
      />
      <span className="truncate text-13 text-ink-strong">{name}</span>
    </span>
  );
}

function WeightSettingLeaderboard({ win }: { win: LeaderboardWindow }) {
  const { data: boardRes } = useSuspenseQuery(chainWeightsQuery(win));
  const subnetById = useSubnetById();
  const board = boardRes.data;
  const network = board.network;
  const dist = board.intensity_distribution;
  const ranked = board.subnets.map((row, i) => ({ ...row, rank: i + 1 }));

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-11 text-ink-muted">Weight-setting activity</h2>
        <p className="mt-1 text-13 text-ink-muted">
          Validator consensus effort ranked by subnet — raw WeightsSet events over the selected
          window.
        </p>
      </div>

      <FactStrip variant="grid">
        <FactCell
          label="Weight-sets"
          value={formatNumber(network.weight_sets)}
          hint={`${win} network total`}
        />
        <FactCell
          label="Distinct setters"
          value={formatNumber(network.distinct_setters)}
          hint="network-wide unique validators"
        />
        <FactCell
          label="Per setter"
          value={network.sets_per_setter != null ? network.sets_per_setter.toFixed(2) : "—"}
          hint="network intensity"
        />
      </FactStrip>

      {dist ? (
        <p className="text-13 text-ink-muted">
          Update intensity across {formatNumber(dist.count)} subnets — median{" "}
          {dist.median.toFixed(2)}, p90 {dist.p90.toFixed(2)}, max {dist.max.toFixed(2)} sets per
          validator.
        </p>
      ) : null}

      {board.subnet_count === 0 || board.subnets.length === 0 ? (
        <EmptyState
          title="No weight-setting activity in this window"
          description="The chain poller has not indexed any WeightsSet events for this window yet, or no validators set weights."
          lastChecked={board.observed_at ?? undefined}
        />
      ) : (
        <div className="space-y-2">
          <p className="text-11 text-ink-muted">
            {formatNumber(board.subnet_count)} subnets
            {board.observed_at ? (
              <>
                {" "}
                · observed <TimeAgo at={board.observed_at} />
              </>
            ) : null}
          </p>
          <DataTable
            rows={ranked}
            rowKey={(row) => String(row.netuid)}
            caption="Per-subnet rankings"
            source="weight-setting"
            link={RouterLink}
            rowHref={(row) => `/subnets/${row.netuid}`}
            columns={[
              { key: "rank", label: "Rank", kind: "number", sortable: true, value: (r) => r.rank },
              {
                key: "subnet",
                label: "Subnet",
                sortable: true,
                value: (r) => subnetById.get(r.netuid)?.name ?? `Subnet ${r.netuid}`,
                render: (r) => (
                  <SubnetIdentity subnet={subnetById.get(r.netuid)} netuid={r.netuid} />
                ),
              },
              {
                key: "weight_sets",
                label: "Weight-sets",
                kind: "number",
                sortable: true,
                value: (r) => r.weight_sets ?? null,
                format: (v) => formatNumber(typeof v === "number" ? v : null),
              },
              {
                key: "distinct_setters",
                label: "Distinct setters",
                kind: "number",
                sortable: true,
                value: (r) => r.distinct_setters ?? null,
                format: (v) => formatNumber(typeof v === "number" ? v : null),
              },
              {
                key: "sets_per_setter",
                label: "Per setter",
                kind: "number",
                sortable: true,
                value: (r) => r.sets_per_setter ?? null,
                format: (v) => formatNumber(typeof v === "number" ? v : null),
              },
            ]}
          />
        </div>
      )}
    </div>
  );
}

// Top-emitters board (#6269) — subnets ranked by their share of network
// emissions, from the already-live GET /api/v1/economics snapshot. Mirrors the
// weight-setting/deregistrations board structure (summary tiles + desktop table
// + < md card fallback); emission_share is not windowed, so this board has no
// window selector.
function EmissionsLeaderboard() {
  const { data: ecoRes } = useSuspenseQuery(economicsQuery());
  const subnetById = useSubnetById();
  const ranked = useMemo(
    () =>
      ((ecoRes.data ?? []) as SubnetEconomics[])
        .filter((s) => typeof s.emission_share === "number")
        .sort((a, b) => (b.emission_share ?? 0) - (a.emission_share ?? 0)),
    [ecoRes],
  );
  const pct = (v: number | undefined) =>
    v != null && Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : "—";
  const topShare = ranked.slice(0, 10).reduce((sum, s) => sum + (s.emission_share ?? 0), 0);
  // Cap the ranked table at the top 20, matching the other boards' page size.
  const top = ranked.slice(0, 20).map((row, i) => ({ ...row, rank: i + 1 }));

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-11 text-ink-muted">Top emitters</h2>
        <p className="mt-1 text-13 text-ink-muted">
          Subnets ranked by their share of network emissions — from the live economics snapshot.
        </p>
      </div>

      <FactStrip variant="grid">
        <FactCell
          label="Subnets emitting"
          value={formatNumber(ranked.length)}
          hint="with an emission share"
        />
        <FactCell
          label="Top emitter"
          value={ranked.length > 0 ? pct(ranked[0].emission_share) : "—"}
          hint={
            ranked.length > 0
              ? (subnetById.get(ranked[0].netuid)?.name ?? `Subnet ${ranked[0].netuid}`)
              : "no data"
          }
        />
        <FactCell label="Top 10 share" value={pct(topShare)} hint="combined network emissions" />
      </FactStrip>

      {ranked.length === 0 ? (
        <EmptyState
          title="No emission data yet"
          description="The economics snapshot has no per-subnet emission share for this network yet."
        />
      ) : (
        <div className="space-y-2">
          <p className="text-11 text-ink-muted">
            top {top.length} of {formatNumber(ranked.length)} subnets
          </p>
          <DataTable
            rows={top}
            rowKey={(row) => String(row.netuid)}
            caption="Per-subnet rankings"
            source="top-emitters"
            link={RouterLink}
            rowHref={(row) => `/subnets/${row.netuid}`}
            columns={[
              { key: "rank", label: "Rank", kind: "number", sortable: true, value: (r) => r.rank },
              {
                key: "subnet",
                label: "Subnet",
                sortable: true,
                value: (r) => subnetById.get(r.netuid)?.name ?? r.name ?? `Subnet ${r.netuid}`,
                render: (r) => (
                  <SubnetIdentity
                    subnet={subnetById.get(r.netuid)}
                    netuid={r.netuid}
                    fallbackName={r.name}
                  />
                ),
              },
              {
                key: "emission_share",
                label: "Emission share",
                kind: "number",
                sortable: true,
                value: (r) => r.emission_share ?? null,
                format: (v) => pct(typeof v === "number" ? v : undefined),
              },
            ]}
          />
        </div>
      )}
    </div>
  );
}

function DeregistrationsLeaderboard({ win }: { win: LeaderboardWindow }) {
  const { data: boardRes } = useSuspenseQuery(chainDeregistrationsQuery(win));
  const subnetById = useSubnetById();
  const board = boardRes.data;
  const network = board.network;
  const ranked = board.subnets.map((row, i) => ({ ...row, rank: i + 1 }));

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-11 text-ink-muted">Deregistrations</h2>
        <p className="mt-1 text-13 text-ink-muted">
          Neuron evictions ranked by subnet — raw NeuronDeregistered events over the selected
          window.
        </p>
      </div>

      <FactStrip variant="grid">
        <FactCell
          label="Deregistrations"
          value={formatNumber(network.deregistrations)}
          hint={`${win} network total`}
        />
        <FactCell
          label="Distinct hotkeys"
          value={formatNumber(network.distinct_deregistered_hotkeys)}
          hint="network-wide unique"
        />
        <FactCell
          label="Per hotkey"
          value={
            network.deregistrations_per_hotkey != null
              ? network.deregistrations_per_hotkey.toFixed(2)
              : "—"
          }
          hint="network intensity"
        />
      </FactStrip>

      {board.subnet_count === 0 || board.subnets.length === 0 ? (
        <EmptyState
          title="No deregistrations in this window"
          description="The chain poller has not indexed any NeuronDeregistered events for this window yet, or eviction activity was zero."
          lastChecked={board.observed_at ?? undefined}
        />
      ) : (
        <div className="space-y-2">
          <p className="text-11 text-ink-muted">
            {formatNumber(board.subnet_count)} subnets
            {board.observed_at ? (
              <>
                {" "}
                · observed <TimeAgo at={board.observed_at} />
              </>
            ) : null}
          </p>
          <DataTable
            rows={ranked}
            rowKey={(row) => String(row.netuid)}
            caption="Per-subnet rankings"
            source="deregistrations"
            link={RouterLink}
            rowHref={(row) => `/subnets/${row.netuid}`}
            columns={[
              { key: "rank", label: "Rank", kind: "number", sortable: true, value: (r) => r.rank },
              {
                key: "subnet",
                label: "Subnet",
                sortable: true,
                value: (r) => subnetById.get(r.netuid)?.name ?? `Subnet ${r.netuid}`,
                render: (r) => (
                  <SubnetIdentity subnet={subnetById.get(r.netuid)} netuid={r.netuid} />
                ),
              },
              {
                key: "deregistrations",
                label: "Deregistrations",
                kind: "number",
                sortable: true,
                value: (r) => r.deregistrations ?? null,
                format: (v) => formatNumber(typeof v === "number" ? v : null),
              },
              {
                key: "distinct_deregistered_hotkeys",
                label: "Distinct hotkeys",
                kind: "number",
                sortable: true,
                value: (r) => r.distinct_deregistered_hotkeys ?? null,
                format: (v) => formatNumber(typeof v === "number" ? v : null),
              },
              {
                key: "deregistrations_per_hotkey",
                label: "Per hotkey",
                kind: "number",
                sortable: true,
                value: (r) => r.deregistrations_per_hotkey ?? null,
                format: (v) => formatNumber(typeof v === "number" ? v : null),
              },
            ]}
          />
        </div>
      )}
    </div>
  );
}
