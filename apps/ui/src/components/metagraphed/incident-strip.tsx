import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { AlertTriangle, ArrowRight, X } from "lucide-react";
import { endpointIncidentsQuery } from "@/lib/metagraphed/queries";
import { netuidFromPathname, sameNetuid } from "@/lib/metagraphed/subnet-probe-health";
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

// The base Bittensor RPC/WSS layer -- the endpoints metagraphed's own proxy
// actually routes through -- as opposed to a subnet's own dashboard/API/data
// artifacts (`subnet-api`/`openapi`/`sse`/`data-artifact`), which fail their
// content probes constantly and are data-quality drift, not a network event.
const BASE_LAYER = "bittensor-base";

export function isMajorOutage(i: EndpointIncident): boolean {
  if (i.ended_at) return false;
  return i.layer === BASE_LAYER && i.severity === "critical";
}

/**
 * Site-wide active-incident banner for operational routes.
 *
 * Reserved for major, network-affecting events: a proxied Bittensor RPC/WSS
 * node fully down (`layer: "bittensor-base"`, `severity: "critical"`) -- not
 * the much larger and noisier stream of individual subnets' own dashboards
 * and APIs failing their content probes, nor transient/degraded blips on an
 * otherwise-redundant RPC pool. Those still show up in the fuller incident
 * feed on /health; they just don't warrant interrupting every page.
 *
 * On a subnet detail page the masthead HealthPill is the sole health signal for
 * *that* subnet (#5332). Incidents scoped to the viewed netuid are therefore
 * omitted here so "SN1 DEGRADED" cannot disagree with a masthead pill that was
 * previously stuck on profile/chain "Unknown". Other subnets' incidents still
 * surface (and the strip still leads on /endpoints).
 */
export function IncidentStrip() {
  // The degraded/incident bar is only contextually relevant on the operational
  // surfaces (endpoints + subnets); on home/about/schemas/etc. it's noise, so we
  // gate it to those routes rather than showing it site-wide.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const viewedNetuid = netuidFromPathname(pathname);
  const { data, error } = useQuery({ ...endpointIncidentsQuery(), retry: 0 });
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  // Hydrate after mount to avoid SSR mismatch.
  useEffect(() => setDismissed(loadDismissed()), []);

  const active = useMemo(() => {
    if (error || !data) return [];
    return (
      (data.data as EndpointIncident[])
        .filter(isMajorOutage)
        .filter((i) => !dismissed.has(i.id))
        // Masthead owns health for the currently viewed subnet (coerce netuid
        // so string/number API values never leave "SN1 DEGRADED" stuck on /subnets/1).
        .filter((i) => viewedNetuid == null || !sameNetuid(i.netuid, viewedNetuid))
    );
  }, [data, error, dismissed, viewedNetuid]);

  const onOperationalRoute = pathname.startsWith("/endpoints") || pathname.startsWith("/subnets");
  if (!onOperationalRoute || active.length === 0) return null;

  const top = active[0]!;
  const isDown = (top.state ?? "").toLowerCase() === "down";
  const severity = isDown ? "Incident" : "Degraded";

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
      <div className="max-w-shell-max mx-auto px-4 md:px-8 py-1.5 flex items-center gap-2.5">
        <AlertTriangle
          className={classNames(
            "size-3.5 shrink-0",
            isDown ? "text-health-down" : "text-health-warn",
          )}
        />
        {/* #3951 redesign: lead with the AFFECTED entity + severity as one token,
            so the banner always reads as that subnet's status — never the current
            page's — and the old standalone label + trailing subnet link collapse
            into it. A net simplification (fewer elements), not another chip. */}
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-widest">
          {top.netuid != null ? (
            <Link
              to="/subnets/$netuid"
              params={{ netuid: top.netuid }}
              className="text-ink-strong underline decoration-dotted underline-offset-2 hover:text-accent"
            >
              SN{top.netuid}
            </Link>
          ) : (
            <span className="text-ink-strong">Network</span>
          )}{" "}
          <span className={isDown ? "text-health-down" : "text-health-warn"}>{severity}</span>
        </span>
        <span className="min-w-0 flex-1 truncate text-ink-muted">
          {top.message ?? `Endpoint ${top.endpoint_id ?? top.id} reported ${top.state ?? "issue"}.`}
        </span>
        <Link
          to="/health"
          className="shrink-0 inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest hover:text-accent"
        >
          {active.length > 1 ? `All ${active.length}` : "View"}
          <ArrowRight className="size-3" />
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
          className="shrink-0 -my-1 inline-flex size-8 items-center justify-center rounded text-ink-muted hover:text-ink-strong hover:bg-surface"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}
