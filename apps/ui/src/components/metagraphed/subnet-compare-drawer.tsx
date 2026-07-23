import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowRight, GitCompare, X } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@jsonbored/ui-kit";
import {
  economicsQuery,
  subnetEndpointsQuery,
  subnetHealthQuery,
  subnetProfileQuery,
} from "@/lib/metagraphed/queries";
import type { Endpoint } from "@/lib/metagraphed/types";
import { classNames, formatNumber } from "@/lib/metagraphed/format";
import { Panel } from "@/components/metagraphed/primitives";

/**
 * Side-by-side compare drawer. The chosen peer netuid is persisted in the
 * `?compare=` URL search param so the comparison is shareable and survives
 * page reloads. A "clear comparison" pill renders inline next to the trigger
 * whenever `?compare` is active, so the user can undo without opening the
 * drawer first.
 */
export function SubnetCompareDrawer({ netuid }: { netuid: number }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const rawPeer = search.compare;
  const peer =
    typeof rawPeer === "number"
      ? rawPeer
      : typeof rawPeer === "string" && /^\d+$/.test(rawPeer)
        ? Number(rawPeer)
        : null;
  const [draft, setDraft] = useState(peer != null ? String(peer) : "");

  const setPeer = useCallback(
    (next: number | null) => {
      navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({
          ...prev,
          compare: next == null ? undefined : next,
        }),
        replace: true,
        resetScroll: false,
      });
    },
    [navigate],
  );

  return (
    <div className="inline-flex items-center gap-1.5">
      <Sheet open={open} onOpenChange={setOpen}>
        {/* #6420: the Compare button is now a SheetTrigger inside <Sheet>, so Radix
            tracks it and restores focus to it on close. As a plain sibling it was
            never the dialog's trigger, so closing dropped focus to <body>. */}
        <SheetTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-ink-strong hover:border-accent/50 hover:text-accent transition-colors mg-focus-ring"
          >
            <GitCompare className="size-3 text-ink-muted" />
            Compare
            {peer != null ? (
              <span className="font-mono text-[10px] text-ink-muted">
                · SN{String(peer).padStart(3, "0")}
              </span>
            ) : null}
          </button>
        </SheetTrigger>

        <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="font-display text-lg">Compare with another subnet</SheetTitle>
            <SheetDescription>
              Pick any active netuid (0–1024). The choice is saved to the URL so the comparison is
              shareable.
            </SheetDescription>
          </SheetHeader>

          <form
            className="mt-4 flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const n = Number(draft.replace(/\D/g, ""));
              if (Number.isFinite(n)) setPeer(n);
            }}
          >
            <label htmlFor="cmp-netuid" className="sr-only">
              Compare against netuid
            </label>
            <input
              id="cmp-netuid"
              inputMode="numeric"
              placeholder="e.g. 1"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="w-32 rounded border border-border bg-card px-2 py-1.5 font-mono text-sm tabular-nums text-ink-strong focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <button
              type="submit"
              className="inline-flex items-center gap-1 rounded border border-border bg-card px-2.5 py-1.5 text-[11px] font-medium text-ink-strong hover:border-accent/50 hover:text-accent"
            >
              Compare <ArrowRight className="size-3" />
            </button>
            {peer != null ? (
              <button
                type="button"
                onClick={() => {
                  setPeer(null);
                  setDraft("");
                }}
                className="ml-auto inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-ink-muted hover:text-ink-strong"
              >
                <X className="size-3" /> clear
              </button>
            ) : null}
          </form>

          <div className="mt-5">
            {peer == null ? (
              <p className="rounded border border-dashed border-border bg-paper/40 px-3 py-6 text-center text-[12px] text-ink-muted">
                Enter a netuid above to load a side-by-side comparison.
              </p>
            ) : (
              <CompareBody base={netuid} peer={peer} />
            )}
          </div>
        </SheetContent>
      </Sheet>

      {peer != null ? (
        <button
          type="button"
          onClick={() => setPeer(null)}
          title="Clear comparison"
          aria-label={`Clear comparison with SN${String(peer).padStart(3, "0")}`}
          className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-primary-soft px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-accent hover:border-accent/60 mg-focus-ring"
        >
          <X className="size-3" /> clear
        </button>
      ) : null}
    </div>
  );
}

function CompareBody({ base, peer }: { base: number; peer: number }) {
  const baseProfile = useQuery(subnetProfileQuery(base));
  const peerProfile = useQuery(subnetProfileQuery(peer));
  const baseEndpoints = useQuery(subnetEndpointsQuery(base));
  const peerEndpoints = useQuery(subnetEndpointsQuery(peer));
  const baseHealth = useQuery(subnetHealthQuery(base));
  const peerHealth = useQuery(subnetHealthQuery(peer));
  const econQ = useQuery(economicsQuery());

  // economicsQuery returns the per-subnet array directly at res.data (the
  // `.subnets` hop is unwrapped inside the query).
  const econs = econQ.data?.data ?? [];
  const baseEcon = econs.find((r) => r.netuid === base);
  const peerEcon = econs.find((r) => r.netuid === peer);

  const baseRatio = ratioOf(baseEcon?.alpha_in_pool, baseEcon?.alpha_out_pool);
  const peerRatio = ratioOf(peerEcon?.alpha_in_pool, peerEcon?.alpha_out_pool);

  const baseProviders = useMemo(
    () => topProviders((baseEndpoints.data?.data ?? []) as Endpoint[]),
    [baseEndpoints.data],
  );
  const peerProviders = useMemo(
    () => topProviders((peerEndpoints.data?.data ?? []) as Endpoint[]),
    [peerEndpoints.data],
  );

  const bh = baseHealth.data?.data;
  const ph = peerHealth.data?.data;
  const baseUptime = bh?.uptime_24h != null ? bh.uptime_24h * 100 : null;
  const peerUptime = ph?.uptime_24h != null ? ph.uptime_24h * 100 : null;

  const loading =
    baseProfile.isPending ||
    peerProfile.isPending ||
    baseEndpoints.isPending ||
    peerEndpoints.isPending ||
    baseHealth.isPending ||
    peerHealth.isPending;

  return (
    <div className="space-y-4">
      <header className="grid grid-cols-2 gap-2">
        <Header label="Current" name={baseProfile.data?.data?.name} netuid={base} />
        <Header label="Compare" name={peerProfile.data?.data?.name} netuid={peer} />
      </header>

      {loading ? (
        <div className="rounded border border-dashed border-border bg-paper/40 px-3 py-6 text-center font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          Loading…
        </div>
      ) : null}

      <DiffRow
        title="Pool ratio (in / total)"
        baseValue={baseRatio != null ? `${baseRatio.toFixed(1)}%` : "—"}
        peerValue={peerRatio != null ? `${peerRatio.toFixed(1)}%` : "—"}
        delta={
          baseRatio != null && peerRatio != null ? `${(peerRatio - baseRatio).toFixed(1)} pp` : null
        }
        highlight={
          baseRatio != null && peerRatio != null ? Math.abs(peerRatio - baseRatio) > 5 : false
        }
      />

      <DiffRow
        title="Endpoint uptime 24h"
        baseValue={baseUptime != null ? `${baseUptime.toFixed(2)}%` : "—"}
        peerValue={peerUptime != null ? `${peerUptime.toFixed(2)}%` : "—"}
        delta={
          baseUptime != null && peerUptime != null
            ? `${(peerUptime - baseUptime).toFixed(2)} pp`
            : null
        }
        highlight={
          baseUptime != null && peerUptime != null ? Math.abs(peerUptime - baseUptime) > 1 : false
        }
      />

      <DiffRow
        title="Tracked endpoints"
        baseValue={formatNumber(
          (bh?.ok ?? 0) + (bh?.warn ?? 0) + (bh?.down ?? 0) + (bh?.unknown ?? 0),
        )}
        peerValue={formatNumber(
          (ph?.ok ?? 0) + (ph?.warn ?? 0) + (ph?.down ?? 0) + (ph?.unknown ?? 0),
        )}
        delta={null}
      />

      <Panel flush className="overflow-hidden">
        <div className="border-b border-border px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          Top providers
        </div>
        <div className="grid grid-cols-2 divide-x divide-border">
          <ProviderColumn rows={baseProviders} other={peerProviders} />
          <ProviderColumn rows={peerProviders} other={baseProviders} />
        </div>
      </Panel>
    </div>
  );
}

function Header({ label, name, netuid }: { label: string; name?: string; netuid: number }) {
  return (
    <Panel as="div" flush>
      <div className="px-2.5 py-2">
        <div className="font-mono text-[9.5px] uppercase tracking-widest text-ink-muted">
          {label}
        </div>
        <div className="mt-0.5 truncate font-display text-sm font-semibold text-ink-strong">
          {name ?? `Subnet ${netuid}`}
        </div>
        <div className="font-mono text-[10px] text-ink-muted">
          netuid {String(netuid).padStart(3, "0")}
        </div>
      </div>
    </Panel>
  );
}

function DiffRow({
  title,
  baseValue,
  peerValue,
  delta,
  highlight,
}: {
  title: string;
  baseValue: string;
  peerValue: string;
  delta: string | null;
  highlight?: boolean;
}) {
  return (
    <div
      className={classNames(
        "rounded-lg border bg-card px-3 py-2.5",
        highlight ? "border-accent/60" : "border-border",
      )}
    >
      <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">{title}</div>
      <div className="mt-1 grid grid-cols-[1fr_auto_1fr] items-baseline gap-3">
        <span className="font-display text-sm font-semibold tabular-nums text-ink-strong">
          {baseValue}
        </span>
        <span className="font-mono text-[10px] text-ink-muted">{delta ?? "vs"}</span>
        <span className="text-right font-display text-sm font-semibold tabular-nums text-ink-strong">
          {peerValue}
        </span>
      </div>
    </div>
  );
}

function ProviderColumn({
  rows,
  other,
}: {
  rows: Array<{ slug: string; name: string; count: number }>;
  other: Array<{ slug: string; name: string; count: number }>;
}) {
  const otherSet = new Set(other.map((r) => r.slug));
  if (rows.length === 0)
    return <div className="px-3 py-3 font-mono text-[10px] text-ink-muted">no providers</div>;
  return (
    <ul className="divide-y divide-border">
      {rows.slice(0, 5).map((r) => {
        const unique = !otherSet.has(r.slug);
        return (
          <li
            key={r.slug}
            className={classNames(
              "flex items-center justify-between gap-2 px-3 py-1.5 text-[12px]",
              unique && "bg-accent/5",
            )}
          >
            <span className="truncate text-ink-strong">{r.name}</span>
            <span className="font-mono text-[10px] tabular-nums text-ink-muted">
              {r.count}
              {unique ? (
                <span className="ml-1 rounded border border-accent/40 px-1 text-[9px] uppercase tracking-widest text-accent">
                  only
                </span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// Pool reserves arrive via the economics index signature (unknown) — coerce.
function ratioOf(inP: unknown, outP: unknown): number | null {
  const i = typeof inP === "number" && Number.isFinite(inP) ? inP : 0;
  const o = typeof outP === "number" && Number.isFinite(outP) ? outP : 0;
  if (i + o <= 0) return null;
  return (i / (i + o)) * 100;
}

function topProviders(endpoints: Endpoint[]) {
  const acc = new Map<string, { slug: string; name: string; count: number }>();
  for (const e of endpoints) {
    const name = e.provider;
    if (!name) continue;
    const slug = e.provider_slug ?? name;
    const cur = acc.get(slug);
    if (cur) cur.count += 1;
    else acc.set(slug, { slug, name, count: 1 });
  }
  return Array.from(acc.values()).sort((a, b) => b.count - a.count);
}
