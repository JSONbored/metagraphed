import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Activity,
  ArrowRight,
  ArrowRightLeft,
  Clock,
  Hash,
  Layers,
  Network,
  Rss,
  Search,
  User,
  Wifi,
  Workflow,
} from "lucide-react";
import { searchQuery } from "@/lib/metagraphed/queries";
import { classNames } from "@/lib/metagraphed/format";
import { Kbd, safeExternalUrl } from "@jsonbored/ui-kit";
import { loadRecent, pushRecent } from "@/lib/metagraphed/search-history";
import { isValidSs58 } from "@/lib/metagraphed/accounts";
import { shortHash } from "@/lib/metagraphed/blocks";
import { isCompositeExtrinsicRef } from "@/lib/metagraphed/extrinsics";
import { pickPromotedSubnetHit, hitKind } from "@/lib/metagraphed/search-hit-score";

interface Props {
  /** Opens the full command palette modal (still bound to ⌘K). */
  onOpenPalette: () => void;
}

interface Hit {
  id: string;
  kind?: string;
  type?: string;
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
  {
    to: "/subnets",
    label: "Subnets",
    hint: "All active Finney subnets",
    Icon: Layers,
  },
  {
    to: "/surfaces",
    label: "Surfaces",
    hint: "Verified public interfaces",
    Icon: Workflow,
  },
  {
    to: "/endpoints",
    label: "Endpoints",
    hint: "RPC, APIs, streams",
    Icon: Wifi,
  },
  {
    to: "/providers",
    label: "Providers",
    hint: "Teams & infrastructure",
    Icon: Network,
  },
  {
    to: "/blocks",
    label: "Blocks",
    hint: "Chain block explorer",
    Icon: Hash,
  },
  {
    to: "/events",
    label: "Events",
    hint: "Chain event feed",
    Icon: Rss,
  },
  {
    to: "/accounts",
    label: "Accounts",
    hint: "Hotkey & coldkey activity",
    Icon: User,
  },
] as const;

function hrefFor(hit: Hit): string {
  const k = hitKind(hit);
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
      params?: Record<string, string | number>;
      icon: typeof User;
      badge: string;
    };

/**
 * Navbar omnibox. Real text input with a wide live-suggestions popover.
 * Supports direct navigation by ss58 wallet address, block number, and 0x
 * tx/block hash — paste any of those and jump straight to the right page.
 * ⌘K opens the full command palette.
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

  const promotedSubnet = useMemo(() => pickPromotedSubnetHit(hits, debounced), [hits, debounced]);

  const visibleHits = useMemo(() => {
    if (!promotedSubnet) return hits;
    return hits.filter((h) => h.id !== promotedSubnet.id);
  }, [hits, promotedSubnet]);

  const grouped = useMemo(() => {
    const m = new Map<string, Hit[]>();
    for (const h of visibleHits) {
      const k = hitKind(h) || "other";
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(h);
    }
    return m;
  }, [visibleHits]);

  // Detect direct-navigation targets from the query — ss58 wallet address,
  // decimal block number, 0x tx hash, or partial 0x block hash.
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
        badge: "wallet",
      });
    }

    if (/^(?:0|[1-9][0-9]{0,9})$/.test(q)) {
      targets.push({
        kind: "nav",
        label: `Block #${q}`,
        hint: "Jump to block by number",
        to: "/blocks/$ref",
        params: { ref: q },
        icon: Hash,
        badge: "block",
      });
    }

    if (isCompositeExtrinsicRef(q)) {
      targets.push({
        kind: "nav",
        label: `Extrinsic ${q}`,
        hint: "Jump to extrinsic by block#index",
        to: "/extrinsics/$hash",
        params: { hash: q },
        icon: ArrowRightLeft,
        badge: "block#index",
      });
    }

    if (/^0x[0-9a-fA-F]{64}$/.test(q)) {
      targets.push(
        {
          kind: "nav",
          label: `Block ${shortHash(q, 8) ?? q}`,
          hint: q,
          to: "/blocks/$ref",
          params: { ref: q },
          icon: Hash,
          badge: "block hash",
        },
        {
          kind: "nav",
          label: `Extrinsic ${shortHash(q, 8) ?? q}`,
          hint: q,
          to: "/extrinsics/$hash",
          params: { hash: q },
          icon: ArrowRightLeft,
          badge: "tx hash",
        },
      );
    } else if (/^0x[0-9a-fA-F]{1,63}$/.test(q)) {
      targets.push({
        kind: "nav",
        label: `Block ${shortHash(q, 8) ?? q}`,
        hint: q,
        to: "/blocks/$ref",
        params: { ref: q },
        icon: Hash,
        badge: "partial hash",
      });
    }

    const netuidMatch = /^(?:sn\s*(\d+)|netuid\s*(\d+))$/i.exec(q);
    if (netuidMatch) {
      const n = Number(netuidMatch[1] ?? netuidMatch[2]);
      if (Number.isFinite(n) && n >= 0 && n <= 1024) {
        targets.push({
          kind: "nav",
          label: `Subnet ${n}`,
          hint: "Go to subnet by netuid",
          to: "/subnets/$netuid",
          params: { netuid: n },
          icon: Layers,
          badge: "subnet",
        });
      }
    }

    if (promotedSubnet?.netuid != null) {
      targets.push({
        kind: "nav",
        label: promotedSubnet.title ?? `Subnet ${promotedSubnet.netuid}`,
        hint: `netuid ${promotedSubnet.netuid}`,
        to: "/subnets/$netuid",
        params: { netuid: promotedSubnet.netuid },
        icon: Layers,
        badge: "subnet",
      });
    }

    return targets;
  }, [debounced, promotedSubnet]);

  const flat: NavTarget[] = useMemo(() => {
    const items: NavTarget[] = [...navTargets];
    for (const arr of grouped.values()) for (const h of arr) items.push({ kind: "hit", hit: h });
    if (debounced) items.push({ kind: "action" });
    return items;
  }, [navTargets, grouped, debounced]);

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
    const href = hrefFor(item.hit);
    const safeHref = safeExternalUrl(href);
    if (safeHref) {
      window.open(safeHref, "_blank", "noopener,noreferrer");
      return;
    }
    const k = hitKind(item.hit);
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

  // Active option id for aria-activedescendant — only meaningful while the results
  // listbox is open with option rows (suggestions mode renders links, not options).
  const activeOptionId =
    showResults && active < flat.length ? `nav-omnibox-option-${active}` : undefined;

  return (
    <div
      ref={wrapRef}
      className="hidden md:block relative flex-1 max-w-xl lg:max-w-2xl xl:max-w-3xl min-w-0"
    >
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
          placeholder="Explore Bittensor…"
          role="combobox"
          aria-label="Search the registry"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls="nav-omnibox-listbox"
          aria-activedescendant={activeOptionId}
          className="flex-1 min-w-0 bg-transparent outline-none text-ink-strong placeholder:text-ink-muted text-sm"
        />
      </div>

      {/* Dropdown — wider than the input, right-aligned */}
      {open ? (
        <div
          id="nav-omnibox-listbox"
          role="listbox"
          className="absolute right-0 mt-1.5 w-[600px] max-w-[calc(100vw-1.5rem)] rounded-xl border border-border bg-paper shadow-2xl z-50 overflow-hidden"
        >
          {/* ── Empty state: no query typed ─────────────────────────── */}
          {showSuggestions ? (
            <div>
              <div className="px-3 pt-3 pb-2">
                <p className="mg-label mb-2">Jump to</p>
                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                  {NAV_LINKS.map((r) => (
                    <Link
                      key={r.to}
                      to={r.to}
                      onClick={() => setOpen(false)}
                      className="group/jump flex items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5 hover:border-accent/40 hover:bg-surface transition-colors"
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

              <div className="mx-3 mb-2 rounded-lg border border-border/60 bg-card/50 px-3 py-2">
                <p className="text-[11px] text-ink-muted leading-relaxed">
                  <span className="font-medium text-ink">Paste anything:</span> wallet address
                  (ss58), block number, transaction hash (0x…) or block hash to jump directly.
                </p>
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
                    const isActive = i === active;
                    return (
                      <button
                        key={`nav-${n.to}-${n.label}`}
                        type="button"
                        id={`nav-omnibox-option-${i}`}
                        role="option"
                        aria-selected={isActive}
                        onMouseEnter={() => setActive(i)}
                        onClick={() => commit(n)}
                        className={classNames(
                          "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors",
                          isActive ? "bg-surface" : "hover:bg-surface/60",
                        )}
                      >
                        <Icon className="size-4 shrink-0 text-accent" />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium text-ink-strong">
                            {n.label}
                          </span>
                          <span className="block font-mono text-[10px] text-ink-muted truncate">
                            {n.hint}
                          </span>
                        </span>
                        <span className="shrink-0 rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 mg-type-micro text-accent/80">
                          {n.badge}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : null}

              {/* Search hits */}
              {isFetching && hits.length === 0 ? (
                <div className="px-3 py-4 text-center font-mono text-[11px] text-ink-muted">
                  Searching…
                </div>
              ) : hits.length === 0 && navTargets.length === 0 ? (
                <div className="px-3 py-4 text-center font-mono text-[11px] text-ink-muted">
                  No results. Try pasting a wallet address, block number, or tx hash.
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
                              id={`nav-omnibox-option-${idx}`}
                              role="option"
                              aria-selected={isActive}
                              onMouseEnter={() => setActive(idx)}
                              onClick={() => commit({ kind: "hit", hit: h })}
                              className={classNames(
                                "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors",
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
                    id={`nav-omnibox-option-${flat.length - 1}`}
                    role="option"
                    aria-selected={active === flat.length - 1}
                    onMouseEnter={() => setActive(flat.length - 1)}
                    onClick={() => commit({ kind: "action" })}
                    className={classNames(
                      "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors",
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
