import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Activity, ArrowRight, Layers, Network, Search, Wifi, Workflow } from "lucide-react";
import { searchQuery } from "@/lib/metagraphed/queries";
import { classNames } from "@/lib/metagraphed/format";
import { Kbd } from "./kbd";
import { loadRecent, pushRecent } from "@/lib/metagraphed/search-history";

interface Props {
  /** Opens the full command palette modal (still bound to ⌘K). */
  onOpenPalette: () => void;
}

interface Hit {
  id: string;
  kind?: string;
  title?: string;
  url?: string;
  netuid?: number;
  slug?: string;
}

const KIND_ICON: Record<string, typeof Layers> = {
  subnet: Layers,
  surface: Workflow,
  endpoint: Wifi,
  provider: Network,
};
const KIND_LABEL: Record<string, string> = {
  subnet: "Subnet",
  surface: "Surface",
  endpoint: "Endpoint",
  provider: "Provider",
};

function hrefFor(hit: Hit): string {
  const k = (hit.kind ?? "").toLowerCase();
  if (k === "subnet" && hit.netuid != null) return `/subnets/${hit.netuid}`;
  if (k === "provider" && hit.slug) return `/providers/${hit.slug}`;
  if (k === "surface") return "/surfaces";
  if (k === "endpoint") return "/endpoints";
  if (hit.netuid != null) return `/subnets/${hit.netuid}`;
  return hit.url ?? "/";
}

/**
 * Navbar omnibox. Real text input with a live suggestions popover. Groups
 * results by entity kind, deep-links straight to the right page, and falls
 * back to a "Search for …" filter action when nothing matches. ⌘K still
 * opens the full command palette modal (handled by the shell).
 */
export function NavOmnibox({ onOpenPalette }: Props) {
  const navigate = useNavigate();
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);

  useEffect(() => {
    setRecent(loadRecent());
  }, [open]);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(q.trim()), 140);
    return () => window.clearTimeout(t);
  }, [q]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const { data, isFetching } = useQuery({
    ...searchQuery(debounced, 12),
    retry: 0,
  });
  const hits = ((data?.data as Hit[] | undefined) ?? []).slice(0, 8);

  // Group hits by kind for visual structure.
  const grouped = useMemo(() => {
    const m = new Map<string, Hit[]>();
    for (const h of hits) {
      const k = (h.kind ?? "other").toLowerCase();
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(h);
    }
    return m;
  }, [hits]);

  // Flat list for keyboard navigation.
  const flat: Array<{ kind: "hit"; hit: Hit } | { kind: "action" }> = [];
  for (const arr of grouped.values()) for (const h of arr) flat.push({ kind: "hit", hit: h });
  if (debounced) flat.push({ kind: "action" });

  // Clamp active index when results change.
  useEffect(() => {
    setActive(0);
  }, [debounced, hits.length]);

  function commit(item: { kind: "hit"; hit: Hit } | { kind: "action" }) {
    if (debounced) pushRecent(debounced);
    setOpen(false);
    if (item.kind === "action") {
      navigate({ to: "/subnets", search: { q: debounced } as never });
      return;
    }
    const href = hrefFor(item.hit);
    if (/^https?:/i.test(href)) {
      window.open(href, "_blank", "noopener,noreferrer");
      return;
    }
    // Navigate using TanStack Router via concrete `to` + `params`.
    const k = (item.hit.kind ?? "").toLowerCase();
    if (k === "subnet" && item.hit.netuid != null) {
      navigate({ to: "/subnets/$netuid", params: { netuid: item.hit.netuid } });
    } else if (k === "provider" && item.hit.slug) {
      navigate({ to: "/providers/$slug", params: { slug: item.hit.slug } });
    } else if (k === "surface") {
      navigate({ to: "/surfaces" });
    } else if (k === "endpoint") {
      navigate({ to: "/endpoints" });
    } else if (item.hit.netuid != null) {
      navigate({ to: "/subnets/$netuid", params: { netuid: item.hit.netuid } });
    } else {
      navigate({ to: "/" });
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(flat.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (flat[active]) commit(flat[active]);
      else if (debounced) commit({ kind: "action" });
    } else if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
    }
  }

  const showResults = open && debounced.length > 0;
  const showSuggestions = open && !debounced;

  return (
    <div ref={wrapRef} className="relative flex-1 max-w-xl lg:max-w-2xl xl:max-w-3xl min-w-0">
      <div
        className={classNames(
          "group inline-flex w-full items-center gap-2 rounded-full border bg-card pl-3 pr-2 py-2 text-left text-sm transition-all min-h-10",
          open ? "border-accent/60 ring-2 ring-accent/20" : "border-border hover:border-accent/40",
        )}
      >
        <Search className="size-3.5 shrink-0 text-ink-muted" />
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Search subnets, surfaces, endpoints, providers…"
          aria-label="Search the registry"
          aria-autocomplete="list"
          aria-expanded={open}
          className="flex-1 min-w-0 bg-transparent outline-none text-ink-strong placeholder:text-ink-muted"
        />
        <button
          type="button"
          onClick={onOpenPalette}
          title="Open command palette"
          aria-label="Open command palette"
          className="hidden sm:inline-flex items-center gap-0.5 shrink-0 text-ink-muted hover:text-ink-strong transition-colors"
        >
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </button>
      </div>

      {open ? (
        <div
          role="listbox"
          className="mg-omnibox-pop absolute left-0 right-0 mt-2 max-h-[70vh] overflow-auto rounded-xl border border-border bg-paper shadow-xl z-40"
        >
          {showSuggestions ? (
            <div className="p-3">
              <div className="mg-label mb-2">Jump to</div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                {[
                  { to: "/subnets", label: "Subnets", Icon: Layers },
                  { to: "/surfaces", label: "Surfaces", Icon: Workflow },
                  { to: "/endpoints", label: "Endpoints", Icon: Wifi },
                  { to: "/providers", label: "Providers", Icon: Network },
                ].map((r) => (
                  <Link
                    key={r.to}
                    to={r.to}
                    onClick={() => setOpen(false)}
                    className="group/jump inline-flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-[12px] text-ink hover:border-accent/40 hover:text-accent transition-colors"
                  >
                    <r.Icon className="size-3.5 text-ink-muted group-hover/jump:text-accent transition-colors" />
                    {r.label}
                  </Link>
                ))}
              </div>
              {recent.length > 0 ? (
                <>
                  <div className="mg-label mt-3 mb-2">Recent</div>
                  <div className="flex flex-wrap gap-1.5">
                    {recent.slice(0, 6).map((r) => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => {
                          setQ(r);
                          setOpen(true);
                          inputRef.current?.focus();
                        }}
                        className="rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-ink-muted hover:text-ink-strong hover:border-accent/40 transition-colors"
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
              <div className="mt-3 pt-3 border-t border-border flex items-center justify-between text-[10px] font-mono text-ink-muted">
                <span>
                  <Kbd>↑</Kbd> <Kbd>↓</Kbd> navigate · <Kbd>↵</Kbd> open
                </span>
                <button
                  type="button"
                  onClick={onOpenPalette}
                  className="hover:text-ink-strong transition-colors inline-flex items-center gap-1"
                >
                  Open full palette <ArrowRight className="size-2.5" />
                </button>
              </div>
            </div>
          ) : null}

          {showResults ? (
            <div className="p-2">
              {isFetching && hits.length === 0 ? (
                <div className="px-3 py-6 text-center font-mono text-[11px] text-ink-muted">
                  Searching…
                </div>
              ) : hits.length === 0 ? (
                <div className="px-3 py-6 text-center font-mono text-[11px] text-ink-muted">
                  No matches.
                </div>
              ) : (
                <>
                  {[...grouped.entries()].map(([kind, items]) => {
                    const Icon = KIND_ICON[kind] ?? Activity;
                    return (
                      <div key={kind} className="mb-1.5 last:mb-0">
                        <div className="px-3 pt-2 pb-1 font-mono text-[9px] uppercase tracking-widest text-ink-muted">
                          {KIND_LABEL[kind] ?? kind}s
                        </div>
                        {items.map((h) => {
                          const idx = flat.findIndex((f) => f.kind === "hit" && f.hit.id === h.id);
                          const isActive = idx === active;
                          const href = hrefFor(h);
                          return (
                            <button
                              key={h.id}
                              type="button"
                              role="option"
                              aria-selected={isActive}
                              onMouseEnter={() => setActive(idx)}
                              onClick={() => commit({ kind: "hit", hit: h })}
                              className={classNames(
                                "group/row w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-left transition-colors",
                                isActive ? "bg-surface" : "hover:bg-surface/60",
                              )}
                            >
                              <Icon className="size-3.5 shrink-0 text-ink-muted" />
                              <span className="min-w-0 flex-1">
                                <span className="block text-sm text-ink-strong truncate">
                                  {h.title ?? h.url ?? h.id}
                                </span>
                                <span className="block font-mono text-[10px] text-ink-muted truncate">
                                  {h.netuid != null
                                    ? `netuid ${h.netuid}`
                                    : (h.slug ?? h.url ?? "")}
                                </span>
                              </span>
                              <span className="font-mono text-[9px] uppercase tracking-widest text-ink-muted truncate max-w-[40%]">
                                {href}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    );
                  })}
                </>
              )}

              {debounced ? (
                <div className="border-t border-border mt-1 pt-1">
                  <button
                    type="button"
                    role="option"
                    aria-selected={active === flat.length - 1}
                    onMouseEnter={() => setActive(flat.length - 1)}
                    onClick={() => commit({ kind: "action" })}
                    className={classNames(
                      "w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-left transition-colors",
                      active === flat.length - 1 ? "bg-surface" : "hover:bg-surface/60",
                    )}
                  >
                    <Search className="size-3.5 text-ink-muted shrink-0" />
                    <span className="text-sm text-ink-strong">
                      Filter /subnets by{" "}
                      <span className="font-mono text-accent-text">"{debounced}"</span>
                    </span>
                    <span className="ml-auto font-mono text-[10px] text-ink-muted">
                      <Kbd>↵</Kbd>
                    </span>
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
