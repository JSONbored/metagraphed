import { useMemo, useState } from "react";
import { useSuspenseQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, GitBranch, Radio, Sparkles, Tag, Boxes } from "lucide-react";
import {
  changelogQuery,
  chainIdentityHistoryQuery,
  endpointIncidentsQuery,
  runtimeVersionHistoryQuery,
} from "@/lib/metagraphed/queries";
import { TimeAgo } from "@jsonbored/ui-kit";
import { Panel } from "@/components/metagraphed/primitives";
import { classNames } from "@/lib/metagraphed/format";
import type { EndpointIncident } from "@/lib/metagraphed/types";
import { useTimeRange, RANGE_HOURS, RANGE_LABEL } from "./time-range-context";
import {
  buildDigestItems,
  countByKind,
  groupByDay,
  DIGEST_KIND_LABEL,
  type DigestItem,
  type DigestKind,
} from "./what-changed-digest";

const KIND_ICON: Record<DigestKind, typeof GitBranch> = {
  registry: GitBranch,
  incident: AlertTriangle,
  identity: Tag,
  runtime: Boxes,
};

const KINDS: DigestKind[] = ["registry", "incident", "identity", "runtime"];

function dayLabel(day: string): string {
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (day === fmt(today)) return "Today";
  if (day === fmt(yesterday)) return "Yesterday";
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, d).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/**
 * "What changed" digest (#8257) — the four event kinds that have a per-event
 * source, grouped by day, filterable by kind, each item deep-linked where it
 * has a page of its own. See what-changed-digest.ts for why two of the six
 * kinds the issue listed are absent rather than approximated.
 *
 * `limit` caps the home module; the full view passes none.
 */
export function WhatChangedFeed({
  className,
  limit,
  showFilters = false,
}: {
  className?: string;
  limit?: number;
  /** Per-kind filter chips. Off for the compact home module. */
  showFilters?: boolean;
}) {
  const { range } = useTimeRange();
  const cutoff = Date.now() - RANGE_HOURS[range] * 3_600_000;
  const { data: cRes } = useSuspenseQuery(changelogQuery());
  const { data: iRes } = useSuspenseQuery(endpointIncidentsQuery());
  // The two chain-side sources are non-suspending: they're additive detail, and
  // a slow or failing one shouldn't hold up (or blank) the whole digest.
  const identity = useQuery(chainIdentityHistoryQuery(50)).data?.data?.changes ?? [];
  const runtime = useQuery(runtimeVersionHistoryQuery()).data?.data?.transitions ?? [];

  const [hidden, setHidden] = useState<Set<DigestKind>>(() => new Set());

  const all = useMemo<DigestItem[]>(
    () =>
      buildDigestItems(
        {
          changelog: (cRes.data ?? []) as Array<{
            id: string;
            title?: string;
            kind?: string;
            at?: string;
          }>,
          incidents: (iRes.data ?? []) as EndpointIncident[],
          identity,
          runtime,
        },
        cutoff,
      ),
    [cRes.data, iRes.data, identity, runtime, cutoff],
  );

  const counts = useMemo(() => countByKind(all), [all]);
  const visible = useMemo(() => {
    const kept = all.filter((i) => !hidden.has(i.kind));
    return limit != null ? kept.slice(0, limit) : kept;
  }, [all, hidden, limit]);
  const days = useMemo(() => groupByDay(visible), [visible]);

  function toggleKind(kind: DigestKind) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  return (
    <Panel as="div" flush className={className}>
      <div className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <div className="mg-type-caption text-ink-muted">
              What changed · {RANGE_LABEL[range]}
            </div>
            <h3 className="mt-0.5 font-display text-sm font-semibold text-ink-strong">
              Recent registry signal
            </h3>
          </div>
          <span className="inline-flex items-center gap-1 mg-type-data-sm text-ink-muted">
            <Sparkles className="size-3" aria-hidden />
            live
          </span>
        </div>

        {showFilters ? (
          <div className="mb-3 flex flex-wrap gap-1.5">
            {KINDS.map((kind) => {
              const on = !hidden.has(kind);
              return (
                <button
                  key={kind}
                  type="button"
                  onClick={() => toggleKind(kind)}
                  aria-pressed={on}
                  className={classNames(
                    "min-h-9 rounded-full border px-2.5 py-1 mg-type-caption transition-colors",
                    on
                      ? "border-accent/40 bg-accent/10 text-accent-text"
                      : "border-border bg-card text-ink-muted hover:border-ink/30",
                  )}
                >
                  {DIGEST_KIND_LABEL[kind]}
                  <span className="ml-1 tabular-nums opacity-70">{counts[kind]}</span>
                </button>
              );
            })}
          </div>
        ) : null}

        {days.length === 0 ? (
          <div className="flex items-center gap-2 py-6 text-xs text-ink-muted">
            <Radio className="size-3.5" aria-hidden />
            {hidden.size > 0 && all.length > 0
              ? "Every event in this range is filtered out — turn a chip back on."
              : `A quiet ${RANGE_LABEL[range]} — nothing changed in the registry, and no incidents opened.`}
          </div>
        ) : (
          <div className="space-y-4">
            {days.map((d) => (
              <section key={d.day}>
                <h4 className="mb-1.5 mg-type-caption text-ink-muted">{dayLabel(d.day)}</h4>
                <ol className="space-y-2.5">
                  {d.items.map((it) => (
                    <DigestRow key={it.id} item={it} />
                  ))}
                </ol>
              </section>
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}

function DigestRow({ item }: { item: DigestItem }) {
  const Icon = KIND_ICON[item.kind];
  const body = (
    <>
      <span
        className={classNames(
          "mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded border",
          item.tone === "accent" && "border-accent/40 text-accent",
          item.tone === "warn" && "border-health-warn/40 text-health-warn",
          item.tone === "down" && "border-health-down/40 text-health-down",
          item.tone === "default" && "border-border text-ink-muted",
        )}
        aria-hidden
      >
        <Icon className="size-3" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-ink-strong transition-colors group-hover:text-accent">
          {item.title}
        </div>
        <div className="mt-0.5 flex items-baseline gap-2">
          {item.detail ? (
            <span className="truncate mg-type-caption text-ink-muted">{item.detail}</span>
          ) : null}
          <span className="mg-type-data-sm text-ink-muted">
            <TimeAgo at={item.at} />
          </span>
        </div>
      </div>
    </>
  );

  return (
    <li className="group">
      {item.href ? (
        <Link
          to={item.href.to}
          params={item.href.params as never}
          className="flex items-start gap-2.5"
        >
          {body}
        </Link>
      ) : (
        <div className="flex items-start gap-2.5">{body}</div>
      )}
    </li>
  );
}
