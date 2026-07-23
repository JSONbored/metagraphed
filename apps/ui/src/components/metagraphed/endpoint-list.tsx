import { Link } from "@tanstack/react-router";
import { ExternalLink as ExternalLinkIcon } from "lucide-react";
import { useMemo } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  HealthDot,
  EligibilityChip,
  TimeAgo,
  BrandIcon,
  safeExternalUrl,
  CopyIconToggle,
  Sparkline,
} from "@jsonbored/ui-kit";
import { useCopy } from "@/hooks/use-copy";
import { Panel } from "@/components/metagraphed/primitives";
import { healthColorVar } from "@/lib/health-tokens";
import { classNames } from "@/lib/metagraphed/format";
import {
  endpointCategory,
  endpointEligibility,
  indexPoolsById,
  CATEGORY_LABEL,
  type EndpointCategory,
} from "@/lib/metagraphed/endpoint-pool";
import type { Endpoint, HealthState, RpcPool } from "@/lib/metagraphed/types";

/**
 * Endpoint list — kind-grouped table on desktop, stacked cards on mobile.
 * Columns: Resource (path + provider) · Auth/Region · Eligibility · Health
 * (sparkline + dot) · Probed · row actions (copy URL, open).
 */
export function EndpointList({
  rows,
  pools = [],
  showNetuid = false,
  showProvider = true,
}: {
  rows: Endpoint[];
  pools?: RpcPool[];
  showNetuid?: boolean;
  showProvider?: boolean;
}) {
  // Group by canonical category, preserving display order
  const groups = useMemo(() => {
    const map = new Map<EndpointCategory, Endpoint[]>();
    for (const e of rows) {
      const cat = endpointCategory(e.kind);
      const list = map.get(cat) ?? [];
      list.push(e);
      map.set(cat, list);
    }
    const order: EndpointCategory[] = ["rpc", "wss", "api", "sse", "data", "other"];
    return order
      .map((c) => ({ category: c, items: map.get(c) ?? [] }))
      .filter((g) => g.items.length > 0);
  }, [rows]);

  // O(1) pool lookup for eligibility (keeps our indexed-by-id helper rather than
  // a per-row array scan).
  const poolsById = useMemo(() => indexPoolsById(pools), [pools]);

  if (rows.length === 0) return null;

  return (
    <TooltipProvider delayDuration={150}>
      {/* Desktop */}
      <Panel as="div" flush className="hidden md:block overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface/50 mg-type-micro text-ink-muted">
              <tr>
                {showNetuid ? <th className="px-4 py-2.5 text-left w-16">SN</th> : null}
                <th className="px-4 py-2.5 text-left">Resource</th>
                {showProvider ? <th className="px-4 py-2.5 text-left w-40">Provider</th> : null}
                <th className="px-4 py-2.5 text-left w-28">
                  <HeaderHint
                    label="Eligibility"
                    hint="Pool / proxy / archive membership. Hover any chip for the rule."
                  />
                </th>
                <th className="px-4 py-2.5 text-left w-40">
                  <HeaderHint
                    label="Health"
                    hint="Probe-derived only. Sparkline shows last 12 probes when available."
                  />
                </th>
                <th className="px-4 py-2.5 text-right w-24">Latency</th>
                <th className="px-4 py-2.5 text-right w-28">Probed</th>
                <th className="px-4 py-2.5 text-right w-20" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {groups.map((g, gi) => (
                <GroupBlock
                  key={g.category}
                  category={g.category}
                  items={g.items}
                  poolsById={poolsById}
                  showNetuid={showNetuid}
                  showProvider={showProvider}
                  isFirst={gi === 0}
                />
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* Mobile */}
      <div className="md:hidden space-y-4">
        {groups.map((g) => (
          <div key={g.category}>
            <div className="px-1 mb-1.5 mg-type-micro text-ink-muted flex items-center justify-between">
              <span>{CATEGORY_LABEL[g.category]}</span>
              <span className="tabular-nums">{g.items.length}</span>
            </div>
            <ul className="space-y-2">
              {g.items.map((e) => (
                <MobileCard
                  key={e.id}
                  e={e}
                  poolsById={poolsById}
                  showNetuid={showNetuid}
                  showProvider={showProvider}
                />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </TooltipProvider>
  );
}

function GroupBlock({
  category,
  items,
  poolsById,
  showNetuid,
  showProvider,
  isFirst,
}: {
  category: EndpointCategory;
  items: Endpoint[];
  poolsById: ReadonlyMap<string, RpcPool>;
  showNetuid: boolean;
  showProvider: boolean;
  isFirst: boolean;
}) {
  const colSpan = 4 + (showNetuid ? 1 : 0) + (showProvider ? 1 : 0) + 2;
  return (
    <>
      <tr className={classNames("bg-surface/30", !isFirst && "border-t border-border")}>
        <td colSpan={colSpan} className="px-4 py-1.5 mg-type-micro text-ink-muted">
          <span className="text-ink-strong">{CATEGORY_LABEL[category]}</span>
          <span className="ml-2 tabular-nums">· {items.length}</span>
        </td>
      </tr>
      {items.map((e) => (
        <Row
          key={e.id}
          e={e}
          poolsById={poolsById}
          showNetuid={showNetuid}
          showProvider={showProvider}
        />
      ))}
    </>
  );
}

function Row({
  e,
  poolsById,
  showNetuid,
  showProvider,
}: {
  e: Endpoint;
  poolsById: ReadonlyMap<string, RpcPool>;
  showNetuid: boolean;
  showProvider: boolean;
}) {
  const { copied, copy } = useCopy({ label: "endpoint url" });
  const series = healthSeries(e);
  const safeUrl = safeExternalUrl(e.url ?? undefined);
  return (
    <tr className="mg-row-hover border-t border-border/60">
      {showNetuid ? (
        <td className="px-4 py-2.5 font-mono text-[11px] text-ink-muted tabular-nums">
          {e.netuid != null ? (
            <Link
              to="/subnets/$netuid"
              params={{ netuid: e.netuid }}
              className="hover:text-ink-strong"
            >
              {String(e.netuid).padStart(3, "0")}
            </Link>
          ) : (
            "—"
          )}
        </td>
      ) : null}
      <td className="px-4 py-2.5">
        <div className="font-mono text-[11.5px] text-ink truncate max-w-[42ch]">{e.url ?? "—"}</div>
        {e.region ? (
          <div className="font-mono text-[10px] text-ink-muted mt-0.5">{e.region}</div>
        ) : null}
      </td>
      {showProvider ? (
        <td className="px-4 py-2.5 text-[12px]">
          {e.provider ? (
            <Link
              to="/providers/$slug"
              params={{ slug: e.provider_slug ?? e.provider }}
              className="inline-flex items-center gap-1.5 hover:text-ink-strong"
            >
              <BrandIcon
                url={e.url}
                providerSlug={e.provider_slug ?? e.provider}
                name={e.provider}
                size={16}
                className="shrink-0"
              />
              <span className="truncate">{e.provider}</span>
            </Link>
          ) : (
            <span className="text-ink-muted">—</span>
          )}
        </td>
      ) : null}
      <td className="px-4 py-2.5">
        <EligibilityChip eligibility={endpointEligibility(e, poolsById)} size="xs" />
      </td>
      <td className="px-4 py-2.5">
        <div className="flex items-center gap-2">
          <HealthDot state={e.health} />
          {series.length > 1 ? (
            <Sparkline
              values={series}
              width={80}
              height={20}
              color={healthColor(e.health)}
              fill
              className="opacity-90"
              ariaLabel="Recent probe trend"
            />
          ) : (
            <span className="font-mono text-[10px] text-ink-muted">—</span>
          )}
        </div>
      </td>
      <td className="px-4 py-2.5 text-right font-mono text-[11px] text-ink-muted tabular-nums">
        {e.latency_ms != null ? `${e.latency_ms}ms` : "—"}
      </td>
      <td className="px-4 py-2.5 text-right font-mono text-[11px] text-ink-muted">
        <TimeAgo at={e.last_probed_at} />
      </td>
      <td className="px-4 py-2.5 text-right">
        <div className="inline-flex items-center gap-0.5">
          {e.url ? (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => copy(e.url!)}
                    aria-label="Copy URL"
                    className="inline-flex size-7 items-center justify-center rounded-md text-ink-muted hover:text-ink-strong hover:bg-surface transition-colors"
                  >
                    <CopyIconToggle copied={copied} size={3.5} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">Copy URL</TooltipContent>
              </Tooltip>
              {safeUrl ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <a
                      href={safeUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label="Open URL"
                      className="inline-flex size-7 items-center justify-center rounded-md text-ink-muted hover:text-ink-strong hover:bg-surface transition-colors"
                    >
                      <ExternalLinkIcon className="size-3.5" />
                    </a>
                  </TooltipTrigger>
                  <TooltipContent side="top">Open in new tab</TooltipContent>
                </Tooltip>
              ) : null}
            </>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

function MobileCard({
  e,
  poolsById,
  showNetuid,
  showProvider,
}: {
  e: Endpoint;
  poolsById: ReadonlyMap<string, RpcPool>;
  showNetuid: boolean;
  showProvider: boolean;
}) {
  const { copied, copy } = useCopy({ label: "endpoint url" });
  const safeUrl = safeExternalUrl(e.url ?? undefined);
  return (
    <li className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="mg-type-micro text-ink-muted">{e.kind ?? "endpoint"}</span>
            {showNetuid && e.netuid != null ? (
              <Link
                to="/subnets/$netuid"
                params={{ netuid: e.netuid }}
                className="font-mono text-[10px] text-ink-muted hover:text-ink-strong"
              >
                sn{String(e.netuid).padStart(3, "0")}
              </Link>
            ) : null}
            <EligibilityChip eligibility={endpointEligibility(e, poolsById)} size="xs" />
          </div>
          <div className="font-mono text-[11px] text-ink break-all">{e.url ?? "—"}</div>
        </div>
        <HealthDot state={e.health} />
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 border-t border-border pt-2 text-[11px]">
        {showProvider ? (
          <>
            <dt className="mg-type-micro text-ink-muted">Provider</dt>
            <dd className="text-right">
              {e.provider ? (
                <Link
                  to="/providers/$slug"
                  params={{ slug: e.provider_slug ?? e.provider }}
                  className="inline-flex items-center gap-1.5 hover:text-ink-strong"
                >
                  <BrandIcon
                    url={e.url}
                    providerSlug={e.provider_slug ?? e.provider}
                    name={e.provider}
                    size={14}
                    className="shrink-0"
                  />
                  {e.provider}
                </Link>
              ) : (
                <span className="text-ink-muted">—</span>
              )}
            </dd>
          </>
        ) : null}
        <dt className="mg-type-micro text-ink-muted">Latency</dt>
        <dd className="text-right font-mono text-ink tabular-nums">
          {e.latency_ms != null ? `${e.latency_ms}ms` : "—"}
        </dd>
        <dt className="mg-type-micro text-ink-muted">Probed</dt>
        <dd className="text-right font-mono text-ink-muted">
          <TimeAgo at={e.last_probed_at} />
        </dd>
      </dl>
      {e.url ? (
        <div className="mt-2 flex items-center justify-end gap-1">
          <button
            type="button"
            onClick={() => copy(e.url!)}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-paper px-2 py-1 mg-type-micro text-ink-muted hover:text-ink-strong hover:border-accent/40"
          >
            <CopyIconToggle copied={copied} /> copy
          </button>
          {safeUrl ? (
            <a
              href={safeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-md border border-border bg-paper px-2 py-1 mg-type-micro text-ink-muted hover:text-ink-strong hover:border-accent/40"
            >
              open <ExternalLinkIcon className="size-3" />
            </a>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function HeaderHint({ label, hint }: { label: string; hint: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* #3433: tabIndex so this trigger is reachable by keyboard at all --
            without it, Radix's Tooltip never receives the focus event that
            opens it, so it can't be opened (or Escape-dismissed) via
            keyboard. Matches EligibilityChip's trigger. */}
        <span
          tabIndex={0}
          className="inline-flex items-center gap-1 cursor-help rounded underline-offset-2 decoration-dotted decoration-ink-subtle hover:decoration-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-[11px] leading-relaxed">
        {hint}
      </TooltipContent>
    </Tooltip>
  );
}

function healthColor(state?: HealthState | string): string {
  const s = (state ?? "unknown") as string;
  if (s === "ok") return healthColorVar("ok");
  if (s === "warn" || s === "degraded") return healthColorVar("warn");
  if (s === "down" || s === "offline") return healthColorVar("down");
  return healthColorVar("unknown");
}

/**
 * Best-effort probe series extraction. The Endpoint type carries an
 * arbitrary index signature, so try a few common shapes; fall back to a
 * derived 2-point line from latency_ms so the cell still visualises.
 */
function healthSeries(e: Endpoint): number[] {
  const cand =
    (e as Record<string, unknown>).probe_history ??
    (e as Record<string, unknown>).latency_history ??
    (e as Record<string, unknown>).history;
  if (Array.isArray(cand)) {
    const nums = cand
      .map((v) =>
        typeof v === "number"
          ? v
          : typeof v === "object" && v && "latency_ms" in v
            ? (v as { latency_ms?: number }).latency_ms
            : undefined,
      )
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (nums.length > 1) return nums.slice(-12);
  }
  return [];
}
