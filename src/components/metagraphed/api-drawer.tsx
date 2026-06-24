import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Code2, ExternalLink as ExternalLinkIcon, Loader2, X } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useApiSourceCtx, type ApiSource } from "@/lib/metagraphed/api-source-context";
import { apiFetch } from "@/lib/metagraphed/client";
import { metagraphedQueryKey } from "@/lib/metagraphed/queries";
import { API_BASE } from "@/lib/metagraphed/config";
import { CopyableCode } from "./copyable-code";
import { Kbd } from "./kbd";
import { classNames } from "@/lib/metagraphed/format";
import { safeExternalUrl } from "./external-link";

/** Header trigger button. Hidden when no page has registered an API source. */
export function ApiDrawerTrigger() {
  const { sources, open } = useApiSourceCtx();
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tgt = e.target as HTMLElement | null;
      const inField =
        tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable);
      if (inField) return;
      if ((e.key === "j" || e.key === "J") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        open();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (sources.length === 0) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={open}
          aria-label="View API source for this page"
          className="hidden md:inline-flex items-center justify-center rounded-md size-9 text-ink-muted hover:text-ink-strong hover:bg-surface transition-colors"
        >
          <Code2 className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-[11px]">
        View in API · <Kbd>⌘</Kbd>
        <Kbd>J</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}

export function ApiDrawer() {
  const { sources, isOpen, setOpen } = useApiSourceCtx();
  const [activePath, setActivePath] = useState<string | null>(null);

  useEffect(() => {
    if (!activePath && sources.length > 0) setActivePath(sources[0]!.path);
    if (activePath && !sources.find((s) => s.path === activePath)) {
      setActivePath(sources[0]?.path ?? null);
    }
  }, [sources, activePath]);

  return (
    <Sheet open={isOpen} onOpenChange={setOpen}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-2xl p-0 bg-paper text-ink border-l border-border flex flex-col"
      >
        <SheetHeader className="px-5 py-4 border-b border-border space-y-1">
          <SheetTitle className="font-display text-base font-semibold text-ink-strong inline-flex items-center gap-2">
            <Code2 className="size-4 text-accent" /> API source
          </SheetTitle>
          <p className="text-[11px] text-ink-muted leading-relaxed">
            Every screen in Metagraphed is powered by a documented JSON endpoint. Copy the URL, open
            it raw, or grab the curl snippet.
          </p>
        </SheetHeader>

        {sources.length > 1 ? (
          <div className="px-5 py-2 border-b border-border flex flex-wrap gap-1">
            {sources.map((s) => (
              <button
                key={s.path}
                type="button"
                onClick={() => setActivePath(s.path)}
                className={classNames(
                  "rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest transition-colors",
                  activePath === s.path
                    ? "border-accent/60 bg-accent/10 text-ink-strong"
                    : "border-border text-ink-muted hover:text-ink-strong",
                )}
              >
                {prettyLabel(s)}
              </button>
            ))}
          </div>
        ) : null}

        <div className="flex-1 overflow-y-auto">
          {activePath ? (
            <ApiSourceBody source={sources.find((s) => s.path === activePath)!} />
          ) : (
            <div className="p-5 text-sm text-ink-muted">No source registered.</div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function prettyLabel(s: ApiSource) {
  if (s.label) return s.label;
  const seg = s.path.split("/").filter(Boolean).slice(-1)[0] ?? s.path;
  return seg.replace(/\.json$/, "");
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function ApiSourceBody({ source }: { source: ApiSource }) {
  const fullUrl = `${API_BASE}${source.path}`;
  const curl = `curl -sS ${shellSingleQuote(fullUrl)} | jq`;

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: metagraphedQueryKey("api-drawer", source.path),
    queryFn: ({ signal }) => apiFetch<unknown>(source.path, { signal }),
    staleTime: 30_000,
    retry: 0,
  });

  const json = useMemo(() => {
    if (!data) return "";
    try {
      return JSON.stringify(data.data, null, 2);
    } catch {
      return String(data.data);
    }
  }, [data]);

  return (
    <div className="p-5 space-y-4">
      <section className="space-y-2">
        <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          Request
        </div>
        <div className="rounded border border-border bg-card p-3 font-mono text-[12px] text-ink-strong break-all flex items-start gap-2">
          <span className="shrink-0 rounded bg-curation-verified/15 text-curation-verified px-1.5 py-0.5 text-[10px] uppercase tracking-widest">
            GET
          </span>
          <span className="min-w-0 flex-1">{fullUrl}</span>
          <a
            href={safeExternalUrl(fullUrl)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open raw"
            className="text-ink-muted hover:text-ink-strong"
          >
            <ExternalLinkIcon className="size-3.5" />
          </a>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <CopyableCode value={fullUrl} label="url" />
          <CopyableCode value={curl} label="curl" />
        </div>
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
            Response
            {data?.meta?.cache ? ` · ${data.meta.cache}` : null}
          </div>
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="font-mono text-[10px] uppercase tracking-widest text-ink-muted hover:text-ink-strong disabled:opacity-50 inline-flex items-center gap-1"
          >
            {isFetching ? <Loader2 className="size-3 animate-spin" /> : null}
            refetch
          </button>
        </div>
        {isLoading ? (
          <div className="rounded border border-border bg-card p-4 text-[12px] text-ink-muted inline-flex items-center gap-2">
            <Loader2 className="size-3.5 animate-spin" /> Loading…
          </div>
        ) : error ? (
          <div className="rounded border border-health-down/40 bg-health-down/5 p-3 text-[12px] text-health-down">
            <div className="font-medium">Request failed</div>
            <div className="mt-1 font-mono text-[11px] opacity-80">{(error as Error).message}</div>
          </div>
        ) : (
          <pre className="max-h-[60vh] overflow-auto rounded border border-border bg-card p-3 font-mono text-[11px] leading-relaxed text-ink-strong whitespace-pre">
            {json}
          </pre>
        )}
      </section>

      <div className="text-[10px] font-mono text-ink-muted">
        Press <Kbd>Esc</Kbd> to close · <Kbd>⌘</Kbd>
        <Kbd>J</Kbd> to reopen
      </div>
    </div>
  );
}

/** Floating close affordance left here in case future routes need a manual hook. */
export function ApiDrawerCloseButton() {
  const { setOpen } = useApiSourceCtx();
  return (
    <button
      type="button"
      onClick={() => setOpen(false)}
      aria-label="Close"
      className="absolute right-3 top-3 text-ink-muted hover:text-ink-strong"
    >
      <X className="size-4" />
    </button>
  );
}
