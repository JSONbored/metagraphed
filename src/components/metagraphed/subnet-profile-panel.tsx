import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { GitMerge, ArrowRight } from "lucide-react";
import {
  economicsQuery,
  lineageQuery,
  subnetEndpointsQuery,
  subnetProfileQuery,
} from "@/lib/metagraphed/queries";
import { SectionAnchor } from "@/components/metagraphed/section-anchor";
import { KeyChip } from "@/components/metagraphed/key-chip";
import { CurationChip } from "@/components/metagraphed/chips";
import { TimeAgo } from "@/components/metagraphed/time-ago";
import { formatNumber } from "@/lib/metagraphed/format";
import { Donut, DonutLegend } from "@/components/metagraphed/charts/donut";
import type { Endpoint } from "@/lib/metagraphed/types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { InfoTooltip } from "@/components/metagraphed/info-tooltip";

interface Field {
  label: string;
  value: number | undefined;
  precision?: number;
  unit?: string;
  hint: string;
}

// Economics pool/ownership fields arrive through the index signature (unknown).
// Coerce defensively: finite number → that number, else a sentinel (0 / undefined).
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function numOrUndef(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function fmt(v: number | undefined, opts: { precision?: number } = {}) {
  if (v == null || !Number.isFinite(v)) return { short: "—", full: "—" };
  const full = opts.precision != null ? v.toFixed(opts.precision) : String(v);
  const short = opts.precision != null ? v.toFixed(opts.precision) : formatNumber(v);
  return { short, full };
}

function Stat({ field, trailing }: { field: Field; trailing?: React.ReactNode }) {
  const { short, full } = fmt(field.value, { precision: field.precision });
  const hasValue = field.value != null && Number.isFinite(field.value);
  return (
    <div className="min-w-0 px-3 py-2">
      <Tooltip delayDuration={200}>
        <TooltipTrigger asChild>
          <div
            tabIndex={0}
            className="font-mono text-[9.5px] uppercase tracking-widest text-ink-muted truncate cursor-help focus:outline-none"
          >
            {field.label}
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs text-[11px] leading-relaxed">
          {field.hint}
        </TooltipContent>
      </Tooltip>
      <div className="mt-1 flex items-baseline gap-1 min-w-0">
        <Tooltip delayDuration={200}>
          <TooltipTrigger asChild>
            <span
              className="min-w-0 truncate font-display text-[14px] font-semibold tabular-nums text-ink-strong"
              tabIndex={hasValue ? 0 : -1}
            >
              {short}
            </span>
          </TooltipTrigger>
          {hasValue ? (
            <TooltipContent side="top" className="font-mono text-[11px]">
              {full}
              {field.unit ? ` ${field.unit}` : ""}
            </TooltipContent>
          ) : null}
        </Tooltip>
        {field.unit && hasValue ? (
          <span className="shrink-0 font-mono text-[9px] uppercase tracking-widest text-ink-muted">
            {field.unit}
          </span>
        ) : null}
        {trailing}
      </div>
    </div>
  );
}

/**
 * Single profile context panel — merges Lineage + Economics + Ownership +
 * Coverage state into one card with clear subsections.
 */
export function SubnetProfilePanel({ netuid }: { netuid: number }) {
  const { data: profileRes } = useSuspenseQuery(subnetProfileQuery(netuid));
  const profile = profileRes.data;
  const { data: econRes } = useQuery(economicsQuery());
  const { data: lineageRes } = useQuery(lineageQuery());
  const { data: endpointsRes } = useQuery(subnetEndpointsQuery(netuid));
  // economicsQuery already returns the per-subnet array at res.data (the
  // `.subnets` hop is unwrapped inside the query) — find our netuid directly.
  const econ = (econRes?.data ?? []).find((r) => r.netuid === netuid);
  // lineageQuery returns a normalized Lineage object whose pairs live under
  // `.links` — never a top-level array.
  const lineage = (lineageRes?.data?.links ?? []).find(
    (l) => l.mainnet_netuid === netuid || l.testnet_netuid === netuid,
  );

  // Pool composition donut data. Pool reserves arrive via the economics
  // index signature, so coerce to finite numbers (absent → 0, no synthesis).
  const inP = num(econ?.alpha_in_pool);
  const outP = num(econ?.alpha_out_pool);
  const poolSegments = [
    { label: "Alpha in", value: inP, color: "var(--accent)" },
    { label: "Alpha out", value: outP, color: "var(--health-warn)" },
  ];
  const ratio = inP + outP > 0 ? (inP / (inP + outP)) * 100 : null;

  // No historical alpha-price series is exposed by the API, so there is no
  // honest price delta to show. Render only the current price (no fabricated Δ).

  // Endpoint topology — by kind bucket.
  const endpoints = (endpointsRes?.data ?? []) as Endpoint[];
  const topology = topologyOf(endpoints);
  const providerLockup = topProviders(endpoints, 3);

  const primary: Field[] = [
    {
      label: "Alpha in",
      value: numOrUndef(econ?.alpha_in_pool),
      hint: "Alpha tokens on the inflow side of this subnet's AMM pool.",
    },
    {
      label: "Alpha out",
      value: numOrUndef(econ?.alpha_out_pool),
      hint: "Alpha tokens on the outflow side of the AMM pool.",
    },
    {
      label: "Alpha price",
      value: numOrUndef(econ?.alpha_price_tao),
      precision: 6,
      unit: "TAO",
      hint: "Most recent on-chain price of one alpha token in TAO.",
    },
    {
      label: "Max stake",
      value: numOrUndef(econ?.max_stake_tao),
      unit: "TAO",
      hint: "Per-validator stake cap configured for this subnet.",
    },
    {
      label: "Max vals",
      value: numOrUndef(econ?.max_validators),
      hint: "Maximum number of validator slots.",
    },
    {
      label: "Miners",
      value: numOrUndef(econ?.miner_count),
      hint: "Active miner UIDs in the metagraph.",
    },
  ];

  const completenessPct =
    profile?.completeness != null ? Math.round(profile.completeness * 100) : null;

  let lineagePeer: { netuid: number; name?: string; label: string } | null = null;
  if (lineage) {
    const isMain = lineage.mainnet_netuid === netuid;
    const peer = isMain
      ? { netuid: lineage.testnet_netuid, name: lineage.testnet_name, label: "Testnet" }
      : { netuid: lineage.mainnet_netuid, name: lineage.mainnet_name, label: "Mainnet" };
    if (peer.netuid != null) lineagePeer = peer as { netuid: number; name?: string; label: string };
  }

  return (
    <SectionAnchor
      id="subnet-profile"
      title="Subnet profile"
      subtitle="Chain identity, AMM economics, ownership keys, and registry curation."
      info="Joined from /api/v1/lineage · /api/v1/economics · /api/v1/subnets/{netuid}/profile"
      tone="ink"
    >
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        {/* Chain identity row */}
        <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-border border-b border-border">
          <Meta
            label="Tempo"
            value={profile?.tempo != null ? String(profile.tempo) : "—"}
            hint="Blocks per epoch for this subnet."
          />
          <Meta
            label="Type"
            value={profile?.subnet_type ?? profile?.type ?? "—"}
            hint="Whether this is the root subnet or an application subnet."
          />
          <Meta
            label="Reg. block"
            value={
              profile?.registration_block != null ? formatNumber(profile.registration_block) : "—"
            }
            hint="Block height at which this subnet was registered."
          />
          <Meta
            label="Mechanisms"
            value={profile?.mechanism_count != null ? String(profile.mechanism_count) : "—"}
            hint="Number of mechanisms exposed on this subnet."
          />
        </div>

        {/* Lineage callout — the canonical #lineage anchor lives in the route's
            SubnetLineageSection; this is an inline summary, so it carries no id. */}
        {lineagePeer ? (
          <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-border bg-surface/20">
            <GitMerge className="size-3.5 text-accent" />
            <span className="text-[12px] text-ink">
              Paired with its {lineagePeer.label.toLowerCase()} counterpart
            </span>
            <ArrowRight className="size-3 text-ink-muted" />
            <Link
              to="/subnets/$netuid"
              params={{ netuid: lineagePeer.netuid }}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-paper px-2.5 py-0.5 text-[11px] font-medium text-ink-strong hover:border-accent/50 hover:text-accent transition-colors"
            >
              <span className="font-mono tabular-nums text-ink-muted">
                {String(lineagePeer.netuid).padStart(3, "0")}
              </span>
              {lineagePeer.name ?? `Subnet ${lineagePeer.netuid}`}
            </Link>
          </div>
        ) : null}

        {/* Visualizations row — pool composition donut + endpoint topology
            donut + top providers lockup. Always rendered, falls back per
            slot when data is absent. */}
        {poolSegments.some((s) => s.value > 0) || topology.length > 0 ? (
          <div className="grid md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-border border-b border-border">
            <div className="flex items-center gap-4 p-4">
              {poolSegments.some((s) => s.value > 0) ? (
                <>
                  <Donut
                    segments={poolSegments}
                    size={80}
                    strokeWidth={12}
                    centerLabel={ratio != null ? `${ratio.toFixed(0)}%` : "—"}
                    centerSub="in"
                  />
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-widest text-ink-muted">
                      Pool composition
                      <InfoTooltip label="Alpha In ÷ (Alpha In + Alpha Out) from the latest on-chain AMM reserves snapshot, taken from /api/v1/economics. Tile shows a `stale` chip when the snapshot is older than the refresh budget; numbers still render from the last known values." />
                    </div>
                    <div className="mt-1 space-y-1 font-mono text-[10px] text-ink-muted">
                      <div className="flex items-center gap-1.5">
                        <span
                          aria-hidden
                          className="inline-block size-2 rounded-sm"
                          style={{ background: "var(--accent)" }}
                        />
                        <span className="text-ink">In</span>
                        <span className="ml-auto tabular-nums text-ink-strong">
                          {formatNumber(inP)}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span
                          aria-hidden
                          className="inline-block size-2 rounded-sm"
                          style={{ background: "var(--health-warn)" }}
                        />
                        <span className="text-ink">Out</span>
                        <span className="ml-auto tabular-nums text-ink-strong">
                          {formatNumber(outP)}
                        </span>
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="font-mono text-[10px] text-ink-muted">No pool data</div>
              )}
            </div>
            <div className="flex items-center gap-4 p-4">
              {topology.length > 0 ? (
                <>
                  <Donut
                    segments={topology}
                    size={80}
                    strokeWidth={12}
                    centerLabel={String(endpoints.length)}
                    centerSub="endpoints"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-widest text-ink-muted">
                      Endpoint topology
                      <InfoTooltip label="Distribution of tracked public endpoints by kind. Only verified surfaces from /api/v1/subnets/{netuid}/endpoints are counted — candidate (unverified) leads are excluded. `unknown` slots indicate the last probe could not classify the endpoint; if the snapshot is stale, values still render from the last known probe." />
                    </div>
                    <DonutLegend segments={topology} />
                  </div>
                </>
              ) : (
                <div className="font-mono text-[10px] text-ink-muted">No endpoints tracked</div>
              )}
            </div>
            <div className="p-4">
              <div className="flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-widest text-ink-muted">
                Top providers
                <InfoTooltip label="Ranked by count of verified surfaces this provider operates for this subnet, joined from /api/v1/providers. Candidate (unverified) leads are excluded. If provider attribution is stale, ranking still renders from the last published snapshot." />
              </div>
              {providerLockup.length > 0 ? (
                <ul className="mt-2 space-y-1.5">
                  {providerLockup.map((p) => (
                    <li key={p.slug} className="flex items-center gap-2 text-[11px]">
                      <span className="inline-flex size-5 items-center justify-center rounded border border-border bg-paper font-mono text-[9px] uppercase text-ink-muted">
                        {p.name.slice(0, 2)}
                      </span>
                      <Link
                        to="/providers/$slug"
                        params={{ slug: p.slug }}
                        className="truncate text-ink-strong hover:text-accent"
                      >
                        {p.name}
                      </Link>
                      <span className="ml-auto font-mono text-[10px] tabular-nums text-ink-muted">
                        {p.count}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="mt-2 font-mono text-[10px] text-ink-muted">
                  No provider attribution yet.
                </div>
              )}
            </div>
          </div>
        ) : null}

        {/* Economics strip */}
        {econ ? (
          <div className="grid grid-cols-3 md:grid-cols-6 divide-x divide-border border-b border-border">
            {primary.map((f) => (
              <Stat key={f.label} field={f} />
            ))}
          </div>
        ) : null}

        {/* Ownership + curation */}
        <div className="grid md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-border">
          <div className="p-4 space-y-2">
            <div className="font-mono text-[9.5px] uppercase tracking-widest text-ink-muted">
              Ownership
            </div>
            {(() => {
              const coldkey = str(econ?.owner_coldkey);
              const hotkey = str(econ?.owner_hotkey);
              return coldkey || hotkey ? (
                <>
                  {coldkey ? (
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="w-16 shrink-0 font-mono text-[9.5px] uppercase tracking-widest text-ink-muted">
                        Coldkey
                      </span>
                      <KeyChip value={coldkey} label="coldkey" className="min-w-0" />
                    </div>
                  ) : null}
                  {hotkey ? (
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="w-16 shrink-0 font-mono text-[9.5px] uppercase tracking-widest text-ink-muted">
                        Hotkey
                      </span>
                      <KeyChip value={hotkey} label="hotkey" className="min-w-0" />
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="text-[11px] text-ink-muted">No ownership keys recorded.</div>
              );
            })()}
          </div>

          <div className="p-4 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[9.5px] uppercase tracking-widest text-ink-muted">
                Registry curation
              </span>
              <CurationChip level={profile?.curation_level} />
            </div>
            {completenessPct != null ? (
              <div>
                <div className="flex items-baseline justify-between mb-1">
                  <span className="font-mono text-[10px] text-ink-muted">Completeness</span>
                  <span className="font-display text-sm font-semibold tabular-nums text-ink-strong">
                    {completenessPct}%
                  </span>
                </div>
                <div
                  className="h-1.5 w-full overflow-hidden rounded bg-surface"
                  role="progressbar"
                  aria-valuenow={completenessPct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div
                    className="h-full bg-ink-strong transition-all"
                    style={{ width: `${completenessPct}%` }}
                  />
                </div>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-mono text-ink-muted">
              {profile?.coverage_level ? (
                <span className="rounded border border-border bg-surface/50 px-1.5 py-0.5 uppercase tracking-wider">
                  {profile.coverage_level}
                </span>
              ) : null}
              {profile?.review_state ? (
                <span className="rounded border border-border bg-surface/50 px-1.5 py-0.5 uppercase tracking-wider">
                  {profile.review_state}
                </span>
              ) : null}
              {profile?.confidence ? (
                <span className="rounded border border-border bg-surface/50 px-1.5 py-0.5 uppercase tracking-wider">
                  conf · {profile.confidence}
                </span>
              ) : null}
              {profile?.reviewed_at ? (
                <span>
                  reviewed <TimeAgo at={profile.reviewed_at} />
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </SectionAnchor>
  );
}

function Meta({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <div
          tabIndex={0}
          className="px-3 py-2 min-w-0 focus:outline-none focus-visible:bg-surface/40"
        >
          <div className="font-mono text-[9.5px] uppercase tracking-widest text-ink-muted truncate">
            {label}
          </div>
          <div className="mt-1 font-display text-sm font-semibold tabular-nums text-ink-strong truncate">
            {value}
          </div>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-[11px] leading-relaxed">
        {hint}
      </TooltipContent>
    </Tooltip>
  );
}

interface TopologySeg {
  label: string;
  value: number;
  color: string;
}

const TOPOLOGY_BUCKETS: Array<{
  id: string;
  label: string;
  color: string;
  match: (k: string) => boolean;
}> = [
  {
    id: "rpc",
    label: "RPC/WSS",
    color: "var(--accent)",
    match: (k) => k === "rpc" || k === "wss" || k === "archive",
  },
  {
    id: "api",
    label: "API/gRPC",
    color: "var(--ink-strong)",
    match: (k) => k === "api" || k === "grpc",
  },
  { id: "sse", label: "SSE", color: "var(--health-ok)", match: (k) => k === "sse" },
  { id: "data", label: "Data", color: "var(--health-warn)", match: (k) => k === "data" },
];

function topologyOf(endpoints: Endpoint[]): TopologySeg[] {
  const counts = new Map<string, number>();
  for (const e of endpoints) {
    const key = String(e.kind ?? "other").toLowerCase();
    const bucket = TOPOLOGY_BUCKETS.find((b) => b.match(key))?.id ?? "other";
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  const result: TopologySeg[] = TOPOLOGY_BUCKETS.filter((b) => (counts.get(b.id) ?? 0) > 0).map(
    (b) => ({
      label: b.label,
      value: counts.get(b.id) ?? 0,
      color: b.color,
    }),
  );
  const other = counts.get("other") ?? 0;
  if (other > 0) result.push({ label: "Other", value: other, color: "var(--border)" });
  return result;
}

interface ProviderLockup {
  slug: string;
  name: string;
  count: number;
}

function topProviders(endpoints: Endpoint[], limit: number): ProviderLockup[] {
  const acc = new Map<string, ProviderLockup>();
  for (const e of endpoints) {
    const name = e.provider;
    if (!name) continue;
    const slug = e.provider_slug ?? name;
    const cur = acc.get(slug);
    if (cur) cur.count += 1;
    else acc.set(slug, { slug, name, count: 1 });
  }
  return Array.from(acc.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}
