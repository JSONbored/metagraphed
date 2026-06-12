import { useEffect, useState } from "react";
import { Check, ChevronDown, Database, Globe2, Pencil } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useApiBase } from "@/hooks/use-api-base";
import { NETWORKS, DEFAULT_API_BASE } from "@/lib/metagraphed/config";
import { classNames } from "@/lib/metagraphed/format";

interface Reach {
  ok: boolean;
  ms?: number;
  checkedAt: number;
}

async function ping(base: string): Promise<Reach> {
  const start = typeof performance !== "undefined" ? performance.now() : Date.now();
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/api/v1/build`, {
      headers: { Accept: "application/json" },
      // best-effort — short timeout via AbortController
    });
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
 * Top-right network/API base switcher. Replaces the static "Finney /
 * Unofficial" chips with a real action: switch the runtime API base for
 * the whole app (persisted to localStorage). Shows a live reachability dot.
 */
export function NetworkSwitcher() {
  const { base, change, isDefault } = useApiBase();
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const [reach, setReach] = useState<Reach | null>(null);
  const [pinging, setPinging] = useState(false);

  // Run a reachability check whenever the base changes (and once on mount).
  useEffect(() => {
    let cancelled = false;
    setPinging(true);
    ping(base).then((r) => {
      if (!cancelled) {
        setReach(r);
        setPinging(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [base]);

  const activeNet = NETWORKS.find((n) => n.url === base);
  const label = activeNet?.label.split(" ")[0] ?? "Custom";

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
          className="inline-flex items-center gap-1.5 rounded border border-border bg-card px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-ink hover:border-ink/30 transition-colors min-h-7"
          title={`API base: ${base}`}
        >
          <Database className="size-3 text-ink-muted" />
          <span className="text-ink-strong">{label}</span>
          <span className={classNames("inline-block size-1.5 rounded-full", dotCls)} aria-hidden />
          <ChevronDown className="size-3 text-ink-muted" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-3 space-y-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted mb-1.5">
            Network
          </div>
          <ul className="space-y-1">
            {NETWORKS.map((n) => {
              const active = n.url === base;
              return (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => {
                      change(n.url);
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
                      <span className="block font-mono text-[10px] text-ink-muted truncate">
                        {n.url}
                      </span>
                      {n.description ? (
                        <span className="mt-0.5 block text-[10px] text-ink-muted">
                          {n.description}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted mb-1.5 flex items-center gap-1">
            <Pencil className="size-3" /> Custom base URL
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!custom.trim()) return;
              change(custom.trim());
              setCustom("");
              setOpen(false);
            }}
            className="flex items-center gap-1"
          >
            <input
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              placeholder="https://api.example.com"
              className="flex-1 rounded border border-border bg-card px-2 py-1 font-mono text-[11px] focus:outline-none focus:border-ink/30"
            />
            <button
              type="submit"
              className="rounded border border-border bg-card px-2 py-1 text-[11px] hover:border-ink/30"
            >
              set
            </button>
          </form>
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
                  ? `Reachable · ${reach.ms ?? "—"} ms`
                  : reach
                    ? "Blocked or unreachable"
                    : "Not checked"}
            </span>
          </div>
          {!isDefault ? (
            <button
              type="button"
              onClick={() => change(DEFAULT_API_BASE)}
              className="mt-1 text-[11px] text-ink-muted hover:text-ink-strong underline underline-offset-2"
            >
              reset to default
            </button>
          ) : null}
        </div>

        <p className="font-mono text-[9px] uppercase tracking-widest text-ink-muted">
          Unofficial registry · public read-only data
        </p>
      </PopoverContent>
    </Popover>
  );
}
