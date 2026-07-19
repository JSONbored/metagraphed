import { useEffect, useState } from "react";
import { Check, ChevronDown, Globe2, Pencil, TerminalSquare } from "lucide-react";
import { Popover, PopoverTrigger } from "@jsonbored/ui-kit";
import { ClampedPopoverContent } from "./clamped-popover-content";
import { useApiBase, useNetwork } from "@/hooks/use-api-base";
import { CHAIN_NETWORKS, LOCAL_DEV, DEFAULT_API_BASE } from "@/lib/metagraphed/config";
import { classNames } from "@/lib/metagraphed/format";

interface Reach {
  ok: boolean;
  ms?: number;
  checkedAt: number;
}

async function ping(url: string): Promise<Reach> {
  const start = typeof performance !== "undefined" ? performance.now() : Date.now();
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    return {
      ok: res.ok,
      ms: Math.round((performance.now?.() ?? Date.now()) - start),
      checkedAt: Date.now(),
    };
  } catch {
    return { ok: false, checkedAt: Date.now() };
  }
}

/**
 * Top-right chain-network switcher. Selects which Bittensor network's DATA the
 * app shows — Mainnet (full) or Testnet (native registry) — by prefixing the
 * API path (same api.metagraph.sh origin). "Local" is a per-developer chain
 * metagraphed can't host, so it's shown as a dev-mode pointer, not a data view.
 * The origin override (advanced) is kept for local/preview Worker development.
 */
export function NetworkSwitcher() {
  const { network, change: changeNetwork } = useNetwork();
  const { base, change: changeBase, isDefault: baseIsDefault } = useApiBase();
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [reach, setReach] = useState<Reach | null>(null);
  const [pinging, setPinging] = useState(false);

  // Reachability of the SELECTED network's data on the current origin.
  const cleanBase = base.replace(/\/$/, "");
  const pingUrl = `${cleanBase}/api/v1/${network.prefix ? `${network.prefix}/` : ""}coverage`;

  useEffect(() => {
    let cancelled = false;
    setPinging(true);
    ping(pingUrl).then((r) => {
      if (!cancelled) {
        setReach(r);
        setPinging(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [pingUrl]);

  const dotCls = pinging
    ? "bg-ink-muted animate-pulse"
    : reach?.ok
      ? "bg-health-ok"
      : reach
        ? "bg-health-down"
        : "bg-ink-muted";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded border border-border bg-card px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-ink hover:border-ink/30 transition-colors min-h-11"
          title={`Network: ${network.label} · ${base}`}
        >
          <Globe2 className="size-3 text-ink-muted" />
          {/* #6902: below md the label is dropped so the trigger collapses to
              an icon-only pill. It renders unconditionally (unlike its sibling
              header actions, which are `hidden md:inline-flex`), and at 375px the
              full "Mainnet" label pushed the shared header 10px past the viewport
              site-wide. The button stays a full tap target that opens the same
              network popover, so it remains reachable on mobile. */}
          <span className="hidden md:inline text-ink-strong">{network.label}</span>
          <span className={classNames("inline-block size-1.5 rounded-full", dotCls)} aria-hidden />
          <ChevronDown className="size-3 text-ink-muted" />
        </button>
      </PopoverTrigger>
      <ClampedPopoverContent align="end" className="w-80 p-3 space-y-3">
        <div>
          <div className="mg-label mb-1.5">Network</div>
          <ul className="space-y-1">
            {CHAIN_NETWORKS.map((n) => {
              const active = n.id === network.id;
              return (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => {
                      changeNetwork(n.id);
                      setOpen(false);
                    }}
                    className={classNames(
                      "w-full flex items-start gap-2 rounded border px-2 py-2 text-left transition-colors",
                      active
                        ? "border-ink-strong/40 bg-surface"
                        : "border-border bg-card hover:border-ink/30",
                    )}
                  >
                    <Globe2 className="mt-0.5 size-3.5 text-ink-muted shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="text-[12px] font-medium text-ink-strong">{n.label}</span>
                        {active ? <Check className="size-3 text-health-ok" /> : null}
                      </span>
                      <span className="mt-0.5 block text-[10px] text-ink-muted">
                        {n.description}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
            <li>
              <div className="rounded border border-dashed border-border bg-card px-2 py-2">
                <div className="flex items-center gap-2">
                  <TerminalSquare className="size-3.5 text-ink-muted shrink-0" />
                  <span className="text-[12px] font-medium text-ink-strong">{LOCAL_DEV.label}</span>
                </div>
                <span className="mt-0.5 block text-[10px] text-ink-muted">
                  {LOCAL_DEV.description}
                </span>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <code className="font-mono text-[10px] text-ink-muted truncate">
                    {LOCAL_DEV.rpc}
                  </code>
                  <a
                    href={LOCAL_DEV.guideUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[10px] text-ink-muted hover:text-ink-strong underline underline-offset-2 shrink-0"
                  >
                    setup →
                  </a>
                </div>
              </div>
            </li>
          </ul>
        </div>

        <div className="rounded border border-border bg-surface/40 px-2 py-1.5 text-[11px] text-ink-muted">
          <div className="flex items-center gap-2">
            <span
              className={classNames("inline-block size-1.5 rounded-full", dotCls)}
              aria-hidden
            />
            <span>
              {pinging
                ? "Pinging…"
                : reach?.ok
                  ? `${network.label} reachable · ${reach.ms ?? "—"} ms`
                  : reach
                    ? "No data on this network"
                    : "Not checked"}
            </span>
          </div>
        </div>

        <div>
          <button
            type="button"
            onClick={() => setShowAdvanced((s) => !s)}
            className="mg-label hover:text-ink-strong flex items-center gap-1"
          >
            <Pencil className="size-3" /> Advanced · API origin
            <ChevronDown
              className={classNames(
                "size-3 transition-transform",
                showAdvanced ? "rotate-180" : "",
              )}
            />
          </button>
          {showAdvanced ? (
            <div className="mt-1.5 space-y-1.5">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!custom.trim()) return;
                  changeBase(custom.trim());
                  setCustom("");
                }}
                className="flex items-center gap-1"
              >
                <input
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  placeholder="http://localhost:8787"
                  // #6422: a placeholder is not an accessible name for AT, so
                  // the field needs its own aria-label -- matching SearchInput's
                  // convention in table-controls.tsx.
                  aria-label="Custom API origin"
                  className="flex-1 rounded border border-border bg-card px-2 py-1 font-mono text-[11px] focus:outline-none focus:border-ink/30"
                />
                <button
                  type="submit"
                  className="rounded border border-border bg-card px-2 py-1 text-[11px] hover:border-ink/30"
                >
                  set
                </button>
              </form>
              <div className="flex items-center justify-between gap-2">
                <code className="font-mono text-[10px] text-ink-muted truncate">{base}</code>
                {!baseIsDefault ? (
                  <button
                    type="button"
                    onClick={() => changeBase(DEFAULT_API_BASE)}
                    className="text-[10px] text-ink-muted hover:text-ink-strong underline underline-offset-2 shrink-0"
                  >
                    reset
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        <p className="font-mono text-[9px] uppercase tracking-widest text-ink-muted">
          Unofficial registry · public read-only data
        </p>
      </ClampedPopoverContent>
    </Popover>
  );
}
