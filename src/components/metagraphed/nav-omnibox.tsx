import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Activity,
  ArrowRightLeft,
  ArrowRight,
  Boxes,
  Clock,
  Hash,
  Layers,
  Network,
  Search,
  User,
  Wifi,
  Workflow,
} from "lucide-react";
import { searchQuery } from "@/lib/metagraphed/queries";
import { classNames } from "@/lib/metagraphed/format";
import { Kbd } from "./kbd";
import { safeExternalUrl } from "./external-link";
import { loadRecent, pushRecent } from "@/lib/metagraphed/search-history";
import { isValidSs58 } from "@/lib/metagraphed/accounts";
import { shortHash } from "@/lib/metagraphed/blocks";

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

const NAV_LINKS = [
  { to: "/subnets", label: "Subnets", hint: "All active Finney subnets", Icon: Layers },
  { to: "/surfaces", label: "Surfaces", hint: "Verified public interfaces", Icon: Workflow },
  { to: "/endpoints", label: "Endpoints", hint: "RPC, APIs, streams", Icon: Wifi },
  { to: "/providers", label: "Providers", hint: "Teams & infrastructure", Icon: Network },
  { to: "/blocks", label: "Blocks", hint: "Chain block explorer", Icon: Hash },
  { to: "/accounts", label: "Accounts", hint: "Hotkey & coldkey activity", Icon: User },
] as const;

function hrefFor(hit: Hit): string {
  const k = (hit.kind ?? "").toLowerCase();
  if (k === "subnet" && hit.netuid != null) return `/subnets/${hit.netuid}`;
  if (k === "provider" && hit.slug) return `/providers/${hit.slug}`;
  if (k === "surface") return "/surfaces";
  if (k === "endpoint") return "/endpoints";
  if (hit.netuid != null) return `/subnets/${hit.netuid}`;
  return hit.url ?? "/";
}

type NavTarget =
  | { kind: "hit"; hit: Hit }
  | { kind: "action" }
  | {
      kind: "nav";
      label: string;
      hint: string;
      to: string;
      params?: Record<string, string>;
      icon: typeof User;
    };

/**
 * Navbar omnibox. Real text input with a live suggestions popover. Groups
 * results by entity kind, deep-links straight to the right page. Supports
 * direct navigation by ss58 address, block number, and 0x hash. ⌘K opens
 * the full command palette.
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

  // Detect direct-navigation targets from the query.
  const navTargets = useMemo((): NavTarget[] => {
    if (!debounced) return [];
    const q = debounced.trim();
    const targets: NavTarget[] = [];
    if (isValidSs58(q)) {
      targets.push({
        kind: "nav",
        label: `Account ${shortHash(q, 8) ?? q}`,
        hint: q,
        to: "/accounts/$ss58",
        params: { ss58: q },
        icon: User,
      });
    }
    if (/^(?:0|[1-9][0-9]{0,9})$/.test(q)) {
      targets.push({
        kind: "nav",
        label: `Block #${q}`,
        hint: "jump to block by number",
        to: "/blocks/$ref",
        params: { ref: q },
        icon: Hash,
      });
    }
    if (/^0x[0-9a-fA-F]{64}$/.test(q)) {
      targets.push(
        {
          kind: "nav",
          label: `Block ${shortHash(q, 8) ?? q}`,
          hint: "by block hash",
          to: "/blocks/$ref",
          params: { ref: q },
          icon: Hash,
        },
        {
          kind: "nav",
          label: `Extrinsic ${shortHash(q, 8) ?? q}`,
          hint: "by extrinsic hash",
          to: "/extrinsics/$hash",
          params: { hash: q },
          icon: ArrowRightLeft,
        },
      );
    } else if (/^0x[0-9a-fA-F]{1,63}$/.test(q)) {
      targets.push({
        kind: "nav",
        label: `Block ${shortHash(q, 8) ?? q}`,
        hint: "by block hash (partial)",
        to: "/blocks/$ref",
        params: { ref: q },
        icon: Hash,
      });
    }
    return targets;
  }, [debounced]);

  // Flat list for keyboard navigation.
  const flat: NavTarget[] = useMemo(() => {
    const items: NavTarget[] = [...navTargets];
    for (const arr of grouped.values()) for (const h of arr) items.push({ kind: "hit", hit: h });
    if (debounced) items.push({ kind: "action" });
    return items;
  }, [navTargets, grouped, debounced]);

  // Clamp active index when results change.
  useEffect(() => {
    setActive(0);
  }, [debounced, hits.length]);

  function commit(item: NavTarget) {
    if (debounced) pushRecent(debounced);
    setOpen(false);
    if (item.kind === "action") {
      navigate({ to: "/subnets", search: { q: debounced } as never });
      return;
    }
    if (item.kind === "nav") {
      navigate({ to: item.to as never, params: (item.params ?? {}) as never });
      return;
    }
    // Hit
    const href = hrefFor(item.hit);
    const safeHref = safeExternalUrl(href);
    if (safeHref) {
      window.open(safeHref, "_blank", "noopener,noreferrer");
      return;
    }
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
      {/* Input */}
      <div
        className={classNames(
          "inline-flex w-full items-center gap-2 rounded-full border bg-card pl-3 pr-2 py-2 text-left text-sm transition-all min-h-10",
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
          placeholder="Search subnets, surfaces, endpoints…"
          aria-label="Search the registry"
          aria-autocomplete="list"
          aria-expanded={open}
          className="flex-1 min-w-0 bg-transparent outline-none text-ink-strong placeholder:text-ink-muted text-sm"
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

      {/* Dropdown */}
      {open ? (
        <div
          role="listbox"
          className="absolute left-0 right-0 mt-1.5 rounded-xl border border-border bg-paper shadow-2xl z-50 overflow-hidden"
        >
          {/* ── Empty state: no query typed ─────────────────────────── */}
          {showSuggestions ? (
            <div>
              <div className="px-3 pt-3 pb-2">
                <p className="mg-label mb-2">Jump to</p>
                <div className="grid grid-cols-2 gap-1">
                  {NAV_LINKS.map((r) => (
                    <Link
                      key={r.to}
                      to={r.to}
                      onClick={() => setOpen(false)}
                      className="group/jump flex items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2 hover:border-accent/40 hover:bg-surface transition-colors"
                    >
                      <r.Icon className="size-3.5 shrink-0 text-ink-muted group-hover/jump:text-accent transition-colors" />
                      <span className="min-w-0">
                        <span className="block text-[12px] font-medium text-ink-strong truncate">
                          {r.label}
                        </span>
                        <span className="block text-[10px] text-ink-muted truncate">{r.hint}</span>
                      </span>
                    </Link>
                  ))}
                </div>
              </div>

              {recent.length > 0 ? (
                <div className="px-3 pb-2 border-t border-border pt-2">
                  <p className="mg-label mb-2 flex items-center gap-1.5">
                    <Clock className="size-3" />
                    Recent
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {recent.slice(0, 5).map((r) => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => {
                          setQ(r);
                          setOpen(true);
                          inputRef.current?.focus();
                        }}
                        className="rounded-full border border-border bg-card px-2.5 py-0.5 text-[11px] text-ink-muted hover:text-ink-strong hover:border-accent/40 transition-colors"
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="px-3 py-2 border-t border-border flex items-center justify-between">
                <span className="font-mono text-[10px] text-ink-muted">
                  <Kbd>↑</Kbd> <Kbd>↓</Kbd> navigate · <Kbd>↵</Kbd> open
                </span>
                <button
                  type="button"
                  onClick={onOpenPalette}
                  className="inline-flex items-center gap-1 font-mono text-[10px] text-ink-muted hover:text-ink-strong transition-colors"
                >
                  Full search
                  <ArrowRight className="size-2.5" />
                </button>
              </div>
            </div>
          ) : null}

          {/* ── Results state: query typed ───────────────────────────── */}
          {showResults ? (
            <div>
              {/* Direct-navigation targets (ss58 / block / extrinsic) */}
              {navTargets.length > 0 ? (
                <div className="px-2 pt-2 pb-1">
                  <p className="px-1 mg-label mb-1">Go to</p>
                  {navTargets.map((n, i) => {
                    if (n.kind !== "nav") return null;
                    const Icon = n.icon;
                    const idx = i;
                    const isActive = idx === active;
                    return (
                      <button
                        key={`nav-${n.to}-${n.label}`}
                        type="button"
                        role="option"
                        aria-selected={isActive}
                        onMouseEnter={() => setActive(idx)}
                        onClick={() => commit(n)}
                        className={classNames(
                          "w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors",
                          isActive ? "bg-surface" : "hover:bg-surface/60",
                        )}
                      >
                        <Icon className="size-3.5 shrink-0 text-accent" />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium text-ink-strong truncate">
                            {n.label}
                          </span>
                          <span className="block font-mono text-[10px] text-ink-muted truncate">
                            {n.hint}
                          </span>
                        </span>
                        <span className="font-mono text-[9px] uppercase tracking-widest text-ink-muted shrink-0">
                          {n.to.split("/")[1]}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : null}

              {/* Search hits */}
              {isFetching && hits.length === 0 ? (
                <div className="px-3 py-5 text-center font-mono text-[11px] text-ink-muted">
                  Searching…
                </div>
              ) : hits.length === 0 && navTargets.length === 0 ? (
                <div className="px-3 py-5 text-center font-mono text-[11px] text-ink-muted">
                  No results.
                </div>
              ) : hits.length > 0 ? (
                <div
                  className={classNames(
                    "px-2 pb-1",
                    navTargets.length > 0 ? "border-t border-border pt-2" : "pt-2",
                  )}
                >
                  {[...grouped.entries()].map(([kind, items]) => {
                    const Icon = KIND_ICON[kind] ?? Activity;
                    return (
                      <div key={kind} className="mb-1 last:mb-0">
                        <p className="px-1 mg-label mb-1">{KIND_LABEL[kind] ?? kind}s</p>
                        {items.map((h) => {
                          const idx = flat.findIndex((f) => f.kind === "hit" && f.hit.id === h.id);
                          const isActive = idx === active;
                          return (
                            <button
                              key={h.id}
                              type="button"
                              role="option"
                              aria-selected={isActive}
                              onMouseEnter={() => setActive(idx)}
                              onClick={() => commit({ kind: "hit", hit: h })}
                              className={classNames(
                                "w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors",
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
                              <Boxes className="size-3 shrink-0 text-ink-muted/40" />
                            </button>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              ) : null}

              {/* "Search for …" fallback action */}
              {debounced ? (
                <div className="px-2 pb-2 border-t border-border pt-2">
                  <button
                    type="button"
                    role="option"
                    aria-selected={active === flat.length - 1}
                    onMouseEnter={() => setActive(flat.length - 1)}
                    onClick={() => commit({ kind: "action" })}
                    className={classNames(
                      "w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors",
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
