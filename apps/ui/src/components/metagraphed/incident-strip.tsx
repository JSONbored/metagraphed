import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { AlertTriangle, ArrowRight, X } from "lucide-react";
import { endpointIncidentsQuery } from "@/lib/metagraphed/queries";
import type { EndpointIncident } from "@/lib/metagraphed/types";
import { classNames } from "@/lib/metagraphed/format";

const STORAGE_KEY = "metagraphed.dismissed-incidents.v1";

function loadDismissed(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const ids = JSON.parse(raw) as string[];
    return new Set(Array.isArray(ids) ? ids : []);
  } catch {
    return new Set();
  }
}

function persistDismissed(set: Set<string>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
  } catch {
    // quota / private mode — ignore
  }
}

function isActive(i: EndpointIncident): boolean {
  if (i.ended_at) return false;
  const state = (i.state ?? "").toLowerCase();
  return state === "down" || state === "warn" || state === "degraded";
}

export function IncidentStrip() {
  // The degraded/incident bar is only contextually relevant on the operational
  // surfaces (endpoints + subnets); on home/about/schemas/etc. it's noise, so we
  // gate it to those routes rather than showing it site-wide.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { data, error } = useQuery({ ...endpointIncidentsQuery(), retry: 0 });
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  // Hydrate after mount to avoid SSR mismatch.
  useEffect(() => setDismissed(loadDismissed()), []);

  const active = useMemo(() => {
    if (error || !data) return [];
    return (data.data as EndpointIncident[]).filter(isActive).filter((i) => !dismissed.has(i.id));
  }, [data, error, dismissed]);

  const onOperationalRoute = pathname.startsWith("/endpoints") || pathname.startsWith("/subnets");
  if (!onOperationalRoute || active.length === 0) return null;

  const top = active[0]!;
  const more = active.length - 1;
  const isDown = (top.state ?? "").toLowerCase() === "down";

  // The strip surfaces the network's single top active incident, which often
  // concerns a different subnet than the one currently being viewed. When its
  // subject differs from the current /subnets/<n> page, label the scope
  // explicitly so the banner isn't misread as this subnet's own status (#3951).
  const currentSubnet = pathname.match(/^\/subnets\/(\d+)(?:\/|$)/)?.[1] ?? null;
  const concernsOtherEntity =
    currentSubnet != null && (top.netuid == null || String(top.netuid) !== currentSubnet);
  const scopeLabel = concernsOtherEntity
    ? top.netuid != null
      ? "Other subnet"
      : "Network-wide"
    : null;

  return (
    <div
      role="alert"
      className={classNames(
        "border-b text-[12px] mg-fade-in",
        isDown
          ? "bg-health-down/10 border-health-down/30 text-ink-strong"
          : "bg-health-warn/10 border-health-warn/30 text-ink-strong",
      )}
    >
      <div className="max-w-shell-max mx-auto px-4 md:px-8 py-1.5 flex items-center gap-3">
        <AlertTriangle
          className={classNames(
            "size-3.5 shrink-0",
            isDown ? "text-health-down" : "text-health-warn",
          )}
        />
        <span className="font-mono text-[10px] uppercase tracking-widest shrink-0">
          {isDown ? "Incident" : "Degraded"}
        </span>
        {scopeLabel ? (
          <span className="shrink-0 rounded-sm border border-ink/20 bg-ink/5 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-ink-muted">
            {scopeLabel}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate">
          {top.message ?? `Endpoint ${top.endpoint_id ?? top.id} reported ${top.state ?? "issue"}.`}
          {top.netuid != null ? (
            <>
              {" · "}
              <Link
                to="/subnets/$netuid"
                params={{ netuid: top.netuid }}
                className="underline hover:text-accent"
              >
                SN{top.netuid}
              </Link>
            </>
          ) : null}
        </span>
        {more > 0 ? (
          <Link
            to="/health"
            className="hidden sm:inline-flex shrink-0 font-mono text-[10px] uppercase tracking-widest text-ink-muted hover:text-ink-strong"
          >
            +{more} more
          </Link>
        ) : null}
        <Link
          to="/health"
          className="shrink-0 inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest hover:text-accent"
        >
          View <ArrowRight className="size-3" />
        </Link>
        <button
          type="button"
          onClick={() => {
            setDismissed((prev) => {
              const next = new Set(prev);
              next.add(top.id);
              persistDismissed(next);
              return next;
            });
          }}
          aria-label="Dismiss incident"
          className="shrink-0 inline-flex size-5 items-center justify-center rounded text-ink-muted hover:text-ink-strong hover:bg-surface"
        >
          <X className="size-3" />
        </button>
      </div>
    </div>
  );
}
