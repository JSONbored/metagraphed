import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Compass, History, Search, X } from "lucide-react";
import { subnetsQuery } from "@/lib/metagraphed/queries";
import {
  loadRecentVisits,
  clearRecentVisits,
  type RecentVisit,
} from "@/lib/metagraphed/recent-visits";
import { loadRecent, clearRecent } from "@/lib/metagraphed/search-history";
import { BrandIcon } from "@jsonbored/ui-kit";
import { classNames } from "@/lib/metagraphed/format";

/**
 * "Continue exploring" rail. Reads recent searches and recently visited
 * entity pages from localStorage and renders one-click deep links back to
 * the filtered view. Renders nothing when there's no local history.
 */
export function ContinueExploring() {
  const [visits, setVisits] = useState<RecentVisit[]>([]);
  const [recent, setRecent] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    function refresh() {
      setVisits(loadRecentVisits());
      setRecent(loadRecent());
    }
    refresh();
    setHydrated(true);
    function onCustom() {
      refresh();
    }
    function onStorage(e: StorageEvent) {
      if (e.key === "mg.recent.visits.v1" || e.key === "mg.search.recent" || e.key === null) {
        refresh();
      }
    }
    window.addEventListener("mg:recent-visits", onCustom);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("mg:recent-visits", onCustom);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  // Try to enrich subnet visits with names from the registry cache (free if
  // /subnets has already been fetched on this page).
  const { data: subnets } = useQuery({ ...subnetsQuery(), retry: 0 });
  const subnetIndex = new Map<number, string>();
  for (const s of subnets?.data ?? []) {
    if (typeof s.netuid === "number") {
      subnetIndex.set(s.netuid, s.name ?? `Subnet ${s.netuid}`);
    }
  }

  if (!hydrated) return null;
  if (visits.length === 0 && recent.length === 0) return null;

  return (
    <section className="mt-12" aria-labelledby="continue-exploring-title">
      <div className="flex items-end justify-between mb-4 gap-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted inline-flex items-center gap-1.5">
            <Compass className="size-3" /> Continue exploring
          </div>
          <h2
            id="continue-exploring-title"
            className="font-display text-lg md:text-xl font-semibold text-ink-strong tracking-tight mt-1"
          >
            Pick up where you left off.
          </h2>
        </div>
        <button
          type="button"
          onClick={() => {
            clearRecentVisits();
            clearRecent();
            setVisits([]);
            setRecent([]);
          }}
          className="font-mono text-[10px] uppercase tracking-widest text-ink-muted hover:text-ink-strong transition-colors inline-flex items-center gap-1"
          aria-label="Clear continue-exploring history"
        >
          <X className="size-3" /> Clear
        </button>
      </div>

      {visits.length > 0 ? (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {visits.slice(0, 6).map((v) => {
            const label =
              v.kind === "subnet"
                ? (subnetIndex.get(Number(v.id)) ?? v.label ?? `Subnet ${v.id}`)
                : (v.label ?? v.id);
            return (
              <Link
                key={`${v.kind}-${v.id}`}
                to={v.href}
                className="mg-recent-card group flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 hover:border-accent/40 transition-colors min-w-0"
              >
                {v.kind === "subnet" ? (
                  <BrandIcon
                    size={22}
                    netuid={Number(v.id)}
                    name={label}
                    fallback={Number(v.id)}
                    className="shrink-0 rounded-md"
                  />
                ) : (
                  <span
                    aria-hidden
                    className="shrink-0 inline-flex items-center justify-center size-[22px] rounded-md border border-border bg-paper text-[10px] font-mono text-ink-muted"
                  >
                    {v.kind === "provider" ? "PR" : "•"}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block font-mono text-[9px] uppercase tracking-widest text-ink-muted">
                    {v.kind === "subnet" ? `SN ${String(v.id).padStart(3, "0")}` : v.kind}
                  </span>
                  <span className="block truncate text-sm font-medium text-ink-strong group-hover:text-accent transition-colors">
                    {label}
                  </span>
                </span>
                <ArrowUpRight className="size-3.5 text-ink-muted shrink-0 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-accent" />
              </Link>
            );
          })}
        </div>
      ) : null}

      {recent.length > 0 ? (
        <div className={classNames(visits.length > 0 ? "mt-4" : "")}>
          <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted mb-2 inline-flex items-center gap-1.5">
            <History className="size-3" /> Recent searches
          </div>
          <ul className="flex flex-wrap gap-1.5">
            {recent.map((q) => (
              <li key={q}>
                <Link
                  to="/subnets"
                  search={{ q } as never}
                  className="group inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-[12px] text-ink hover:border-accent/40 hover:text-accent transition-colors"
                >
                  <Search className="size-3 text-ink-muted group-hover:text-accent transition-colors" />
                  <span className="truncate max-w-[200px]">{q}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
