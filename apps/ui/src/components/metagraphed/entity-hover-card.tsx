import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { BrandIcon } from "./brand-icon";
import { CurationChip, HealthPill } from "./chips";
import { TimeAgo } from "./time-ago";
import { subnetQuery, providerQuery } from "@/lib/metagraphed/queries";
import { formatNumber } from "@/lib/metagraphed/format";

interface SubnetHoverProps {
  kind: "subnet";
  netuid: number;
  children: ReactNode;
}
interface ProviderHoverProps {
  kind: "provider";
  slug: string;
  children: ReactNode;
}
type Props = SubnetHoverProps | ProviderHoverProps;

/**
 * Detect a touch-primary device. On those we don't render a hover card at
 * all — the trigger renders as-is so the underlying <Link> remains the
 * one-tap target. Avoids the "tap once to hover, tap again to navigate"
 * trap of Radix HoverCard on mobile.
 */
function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const m = window.matchMedia("(hover: none), (pointer: coarse)");
    const update = () => setCoarse(m.matches);
    update();
    m.addEventListener?.("change", update);
    return () => m.removeEventListener?.("change", update);
  }, []);
  return coarse;
}

/**
 * Linear-style hover profile card. Wraps any link/trigger and fetches its
 * detail payload on first open (cached via the shared query client).
 *
 * On touch devices this is a no-op passthrough so taps go straight to the
 * wrapped link, which keeps accessibility predictable.
 */
export function EntityHoverCard(props: Props) {
  const coarse = useCoarsePointer();
  if (coarse) return <>{props.children}</>;

  const ariaLabel =
    props.kind === "subnet" ? `Preview subnet ${props.netuid}` : `Preview provider ${props.slug}`;

  return (
    <HoverCard openDelay={250} closeDelay={120}>
      <HoverCardTrigger asChild>{props.children}</HoverCardTrigger>
      <HoverCardContent
        side="top"
        align="start"
        sideOffset={8}
        aria-label={ariaLabel}
        data-testid="entity-hover-card"
        className="w-80 p-3 bg-card border-border shadow-lg z-50"
      >
        {props.kind === "subnet" ? (
          <SubnetMiniProfile netuid={props.netuid} />
        ) : (
          <ProviderMiniProfile slug={props.slug} />
        )}
      </HoverCardContent>
    </HoverCard>
  );
}

function SubnetMiniProfile({ netuid }: { netuid: number }) {
  const { data, isPending, error } = useQuery({
    ...subnetQuery(netuid),
    staleTime: 5 * 60_000,
  });
  if (isPending) return <Loading />;
  if (error || !data?.data) return <Failed />;
  const s = data.data;
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2.5">
        <BrandIcon
          size={32}
          name={s.name ?? `Subnet ${netuid}`}
          fallback={netuid}
          url={s.website}
          netuid={netuid}
        />
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[9px] uppercase tracking-widest text-ink-muted">
            SN{netuid}
            {s.symbol ? ` · ${s.symbol}` : ""}
          </div>
          <div className="font-display text-sm font-semibold text-ink-strong truncate">
            {s.name ?? `Subnet ${netuid}`}
          </div>
        </div>
        <HealthPill state={s.health ?? "unknown"} />
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <CurationChip level={s.curation_level} />
        {s.type ? (
          <span className="font-mono text-[10px] uppercase text-ink-muted">{s.type}</span>
        ) : null}
      </div>
      <dl className="grid grid-cols-3 gap-2 pt-1">
        <Mini label="Participants" value={formatNumber(s.participants)} />
        <Mini label="Surfaces" value={s.surfaces_count != null ? String(s.surfaces_count) : "—"} />
        <Mini
          label="Candidates"
          value={s.candidates_count != null ? String(s.candidates_count) : "—"}
        />
      </dl>
      {s.updated_at || s.freshness ? (
        <div className="pt-1 border-t border-border font-mono text-[10px] text-ink-muted">
          updated <TimeAgo at={s.updated_at ?? s.freshness} />
        </div>
      ) : null}
    </div>
  );
}

function ProviderMiniProfile({ slug }: { slug: string }) {
  const { data, isPending, error } = useQuery({
    ...providerQuery(slug),
    staleTime: 5 * 60_000,
  });
  if (isPending) return <Loading />;
  if (error || !data?.data) return <Failed />;
  const p = data.data;
  const sum = p.endpoint_summary;
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2.5">
        <BrandIcon
          size={32}
          name={p.name ?? slug}
          fallback={slug}
          url={p.website ?? p.homepage}
          providerSlug={slug}
          iconUrl={p.icon_url}
          repoUrl={p.repo}
        />
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[9px] uppercase tracking-widest text-ink-muted">
            {p.kind ?? "provider"}
          </div>
          <div className="font-display text-sm font-semibold text-ink-strong truncate">
            {p.name ?? slug}
          </div>
          <div className="font-mono text-[10px] text-ink-muted truncate">{slug}</div>
        </div>
      </div>
      {p.notes ? <p className="text-[11px] text-ink-muted line-clamp-3">{p.notes}</p> : null}
      <dl className="grid grid-cols-3 gap-2 pt-1">
        <Mini label="Surfaces" value={String(p.surfaces_count ?? "—")} />
        <Mini label="Endpoints" value={String(p.endpoints_count ?? sum?.endpoint_count ?? "—")} />
        <Mini label="Authority" value={p.authority ?? "—"} />
      </dl>
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded border border-border/60 bg-paper/40 px-2 py-1">
      <dt className="font-mono text-[9px] uppercase tracking-widest text-ink-muted">{label}</dt>
      <dd className="font-mono text-[12px] text-ink-strong truncate">{value}</dd>
    </div>
  );
}

function Loading() {
  return (
    <div className="space-y-2">
      <div className="h-8 rounded bg-surface animate-pulse" />
      <div className="h-3 w-1/2 rounded bg-surface animate-pulse" />
      <div className="h-10 rounded bg-surface animate-pulse" />
    </div>
  );
}
function Failed() {
  return (
    <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
      Preview unavailable
    </div>
  );
}
