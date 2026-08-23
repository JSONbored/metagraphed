import { Link } from "@tanstack/react-router";
import { ExternalLink as ExternalLinkIcon } from "lucide-react";
import { useMemo } from "react";
import {
  HealthDot,
  EligibilityChip,
  BrandIcon,
  DataTable,
  safeExternalUrl,
  CopyIconToggle,
  ExternalLink,
  TrendDelta,
  type DataTableColumn,
} from "@jsonbored/ui-kit";
import { useCopy } from "@/hooks/use-copy";
import { RouterLink } from "@/components/metagraphed/router-link";
import {
  endpointCategory,
  endpointEligibility,
  indexPoolsById,
  CATEGORY_LABEL,
  type EndpointCategory,
} from "@/lib/metagraphed/endpoint-pool";
import type { Endpoint, RpcPool } from "@/lib/metagraphed/types";

/**
 * Endpoint list — one table per canonical kind, so the grouping the reader
 * needs is a heading rather than a spanning row buried inside one long body.
 * Columns: Resource (path + region) · Provider · Eligibility · Health
 * (sparkline + dot) · Latency · Probed · row actions (copy URL, open).
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

  const columns = useMemo<Array<DataTableColumn<Endpoint>>>(() => {
    const list: Array<DataTableColumn<Endpoint>> = [];
    if (showNetuid) {
      list.push({
        key: "netuid",
        label: "SN",
        kind: "number",
        align: "left",
        sortable: true,
        value: (e) => e.netuid ?? null,
        render: (e) =>
          e.netuid != null ? (
            <Link
              to="/subnets/$netuid"
              params={{ netuid: e.netuid }}
              className="tabular-nums hover:text-ink-strong"
            >
              {String(e.netuid).padStart(3, "0")}
            </Link>
          ) : (
            "—"
          ),
      });
    }
    list.push({
      key: "resource",
      label: "Resource",
      sortable: true,
      value: (e) => e.url ?? null,
      render: (e) => (
        <span className="block min-w-0">
          <span className="block truncate text-ink">{e.url ?? "—"}</span>
          {e.region ? <span className="block text-10 text-ink-muted">{e.region}</span> : null}
        </span>
      ),
    });
    if (showProvider) {
      list.push({
        key: "provider",
        label: "Provider",
        sortable: true,
        value: (e) => e.provider ?? null,
        render: (e) =>
          e.provider ? (
            <Link
              to="/providers/$slug"
              params={{ slug: e.provider_slug ?? e.provider }}
              className="inline-flex min-w-0 items-center gap-1.5 hover:text-ink-strong"
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
          ),
      });
    }
    list.push(
      {
        key: "eligibility",
        label: "Eligibility",
        value: (e) => endpointEligibility(e, poolsById),
        render: (e) => (
          <EligibilityChip eligibility={endpointEligibility(e, poolsById)} size="xs" />
        ),
      },
      {
        key: "health",
        label: "Health",
        definition: "Health",
        sortable: true,
        value: (e) => e.health ?? null,
        render: (e) => {
          const series = healthSeries(e);
          return (
            <span className="inline-flex items-center gap-2">
              <HealthDot state={e.health} />
              {series.length > 1 ? (
                <TrendDelta values={series} label="Recent probe latency" />
              ) : (
                <span className="text-10 text-ink-muted">—</span>
              )}
            </span>
          );
        },
      },
      {
        key: "latency",
        label: "Latency",
        kind: "number",
        sortable: true,
        value: (e) => e.latency_ms ?? null,
        format: (v) => (typeof v === "number" ? `${v}ms` : "—"),
      },
      {
        key: "probed",
        label: "Probed",
        kind: "time",
        sortable: true,
        value: (e) => e.last_probed_at,
      },
      {
        key: "actions",
        label: "Actions",
        align: "right",
        value: () => null,
        render: (e) => <RowActions endpoint={e} />,
      },
    );
    return list;
  }, [poolsById, showNetuid, showProvider]);

  if (rows.length === 0) return null;

  return (
    <div className="space-y-6">
      {groups.map((g) => (
        <DataTable
          key={g.category}
          rows={g.items}
          columns={columns}
          rowKey={(e) => e.id}
          caption={CATEGORY_LABEL[g.category]}
          link={RouterLink}
          source={`endpoints-${g.category}`}
          // Eight columns, two of them controls: a labelled card is the only
          // shape below 640px that keeps the copy/open actions reachable.
          mobile="cards"
        />
      ))}
    </div>
  );
}

/** Copy the URL, or open it — the two things a reader does with an endpoint. */
function RowActions({ endpoint }: { endpoint: Endpoint }) {
  const { copied, copy } = useCopy({ label: "endpoint url" });
  const url = endpoint.url;
  const safeUrl = safeExternalUrl(url ?? undefined);
  if (!url) return null;
  return (
    <span className="inline-flex items-center gap-0.5">
      <button
        type="button"
        onClick={() => copy(url)}
        aria-label="Copy URL"
        className="inline-flex size-7 items-center justify-center rounded text-ink-muted transition-colors hover:bg-surface hover:text-ink-strong"
      >
        <CopyIconToggle copied={copied} size={3.5} />
      </button>
      {safeUrl ? (
        <ExternalLink
          bare
          href={safeUrl}
          ariaLabel="Open URL"
          className="inline-flex size-7 items-center justify-center rounded text-ink-muted transition-colors hover:bg-surface hover:text-ink-strong"
        >
          <ExternalLinkIcon className="size-3.5" />
        </ExternalLink>
      ) : null}
    </span>
  );
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
