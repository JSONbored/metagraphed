import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Copy, Check, ExternalLink as ExternalLinkIcon } from "lucide-react";
import { apiFetch } from "@/lib/metagraphed/client";
import { metagraphedQueryKey } from "@/lib/metagraphed/queries";
import { TimeAgo } from "@/components/metagraphed/time-ago";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useCopy } from "@/hooks/use-copy";
import { classNames } from "@/lib/metagraphed/format";
import type { EvidenceItem, PrimaryLinks } from "@/lib/metagraphed/types";

interface Props {
  netuid: number;
  links?: PrimaryLinks;
  /** Initial collapsed row width — defaults to ~6 chips. */
  collapsedCount?: number;
}

/**
 * Subnet header companion: grouped, collapsible chip clusters for evidence
 * (source-kind) and sources (provider links). Each chip opens a shadcn
 * Popover (click + Esc + outside-click) with full URL, copy, and open
 * actions. Copy uses useCopy which toasts success and failure via sonner.
 */
export function EvidenceClusters({ netuid, links, collapsedCount = 6 }: Props) {
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);

  const query = useQuery({
    queryKey: metagraphedQueryKey("evidence-cluster", netuid),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>("/api/v1/evidence", {
        params: { netuid, limit: 80 },
        signal,
      });
      const raw = res.data as unknown;
      let items: EvidenceItem[] = [];
      if (Array.isArray(raw)) items = raw as EvidenceItem[];
      else if (raw && typeof raw === "object") {
        const obj = raw as Record<string, unknown>;
        const cand = obj.evidence ?? obj.entries ?? obj.items;
        if (Array.isArray(cand)) items = cand as EvidenceItem[];
      }
      return items;
    },
    staleTime: 5 * 60_000,
    retry: 0,
  });

  const evidence = query.data ?? [];

  const evidenceBySource = useMemo(() => {
    const m = new Map<string, EvidenceItem[]>();
    for (const e of evidence) {
      const k = e.source ?? "unknown";
      (m.get(k) ?? m.set(k, []).get(k)!).push(e);
    }
    return Array.from(m.entries()).sort((a, b) => b[1].length - a[1].length);
  }, [evidence]);

  const sourceLinks = useMemo<Array<{ label: string; url: string; kind: string }>>(() => {
    const out: Array<{ label: string; url: string; kind: string }> = [];
    if (links?.website)
      out.push({ label: hostOf(links.website), url: links.website, kind: "site" });
    if (links?.docs) out.push({ label: hostOf(links.docs), url: links.docs, kind: "docs" });
    if (links?.repo) out.push({ label: hostOf(links.repo), url: links.repo, kind: "repo" });
    if (links?.dashboard)
      out.push({ label: hostOf(links.dashboard), url: links.dashboard, kind: "dashboard" });
    return out;
  }, [links]);

  if (evidenceBySource.length === 0 && sourceLinks.length === 0) return null;

  return (
    <div className="mt-6 space-y-3" id="evidence">
      {evidenceBySource.length > 0 ? (
        <Cluster
          label="Evidence"
          count={evidence.length}
          subtitle={`${evidenceBySource.length} source${evidenceBySource.length === 1 ? "" : "s"}`}
          open={evidenceOpen}
          onToggle={() => setEvidenceOpen((v) => !v)}
        >
          {evidenceBySource.map(([source, items]) => (
            <GroupRow key={source} label={source} count={items.length}>
              {(evidenceOpen ? items : items.slice(0, collapsedCount)).map((item) => (
                <EvidencePill key={item.id} item={item} />
              ))}
              {!evidenceOpen && items.length > collapsedCount ? (
                <span className="text-[10px] font-mono text-ink-muted self-center">
                  +{items.length - collapsedCount}
                </span>
              ) : null}
            </GroupRow>
          ))}
        </Cluster>
      ) : null}

      {sourceLinks.length > 0 ? (
        <Cluster
          label="Sources"
          count={sourceLinks.length}
          subtitle="public links"
          open={sourcesOpen}
          onToggle={() => setSourcesOpen((v) => !v)}
          id="sources"
        >
          <div className="flex flex-wrap gap-1.5">
            {(sourcesOpen ? sourceLinks : sourceLinks.slice(0, collapsedCount)).map((s) => (
              <SourcePill key={s.url} url={s.url} label={s.label} kind={s.kind} />
            ))}
            {!sourcesOpen && sourceLinks.length > collapsedCount ? (
              <span className="text-[10px] font-mono text-ink-muted self-center">
                +{sourceLinks.length - collapsedCount}
              </span>
            ) : null}
          </div>
        </Cluster>
      ) : null}
    </div>
  );
}

function Cluster({
  label,
  count,
  subtitle,
  open,
  onToggle,
  children,
  id,
}: {
  label: string;
  count: number;
  subtitle?: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  id?: string;
}) {
  return (
    <div id={id} className="rounded-xl border border-border bg-card/60 px-4 py-3">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 text-left"
        aria-expanded={open}
      >
        <span className="inline-flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-muted">
            {label}
          </span>
          <span className="font-display text-sm font-semibold text-ink-strong tabular-nums">
            {count}
          </span>
          {subtitle ? (
            <span className="font-mono text-[10px] text-ink-muted">· {subtitle}</span>
          ) : null}
        </span>
        <ChevronDown
          className={classNames(
            "size-3.5 text-ink-muted transition-transform duration-150",
            open && "rotate-180",
          )}
        />
      </button>
      <div className="mt-3 space-y-2">{children}</div>
    </div>
  );
}

function GroupRow({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-2 first:border-0 first:pt-0">
      <span className="inline-flex items-center gap-1.5 min-w-[110px]">
        <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          {label}
        </span>
        <span className="font-mono text-[10px] text-ink-subtle-text">{count}</span>
      </span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function EvidencePill({ item }: { item: EvidenceItem }) {
  const { copied, copy } = useCopy({ label: "evidence url" });
  const label = shortLabel(item);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-6 items-center rounded-full border border-border bg-paper px-2.5 text-[11px] text-ink hover:border-accent/60 hover:text-ink-strong transition-all duration-150 active:scale-[0.97]"
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="w-80 p-3 mg-fade-in">
        <div className="space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-muted">
              {item.source ?? "source"}
            </span>
            {item.netuid != null ? (
              <span className="font-mono text-[10px] text-ink-muted">SN{item.netuid}</span>
            ) : null}
          </div>
          {item.note ? (
            <div className="text-[12px] text-ink-strong leading-relaxed">{item.note}</div>
          ) : null}
          {item.url ? (
            <div className="font-mono text-[10px] text-ink break-all border border-border bg-paper rounded px-2 py-1.5 leading-relaxed">
              {item.url}
            </div>
          ) : null}
          <div className="flex items-center justify-between font-mono text-[10px] text-ink-muted">
            <span>
              recorded <TimeAgo at={item.recorded_at} />
            </span>
            {item.url ? (
              <span className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => copy(item.url!)}
                  className="inline-flex items-center gap-1 hover:text-ink-strong transition-colors"
                >
                  {copied ? (
                    <Check className="size-3 text-health-ok" />
                  ) : (
                    <Copy className="size-3" />
                  )}
                  {copied ? "copied" : "copy"}
                </button>
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 hover:text-ink-strong transition-colors"
                >
                  open <ExternalLinkIcon className="size-3" />
                </a>
              </span>
            ) : null}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SourcePill({ url, label, kind }: { url: string; label: string; kind: string }) {
  const { copied, copy } = useCopy({ label: `${kind} url` });
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="group inline-flex h-6 items-center gap-1.5 rounded-full border border-border bg-paper px-2.5 text-[11px] hover:border-accent/60 transition-all duration-150 active:scale-[0.97]"
        >
          <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
            {kind}
          </span>
          <span className="font-mono text-ink">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="w-80 p-3 mg-fade-in">
        <div className="space-y-2.5">
          <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-muted">
            {kind} link
          </div>
          <div className="font-mono text-[10px] text-ink break-all border border-border bg-paper rounded px-2 py-1.5 leading-relaxed">
            {url}
          </div>
          <div className="flex items-center justify-end gap-2.5 font-mono text-[10px] text-ink-muted">
            <button
              type="button"
              onClick={() => copy(url)}
              className="inline-flex items-center gap-1 hover:text-ink-strong transition-colors"
            >
              {copied ? <Check className="size-3 text-health-ok" /> : <Copy className="size-3" />}
              {copied ? "copied" : "copy"}
            </button>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 hover:text-ink-strong transition-colors"
            >
              open <ExternalLinkIcon className="size-3" />
            </a>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function shortLabel(item: EvidenceItem): string {
  if (item.note && item.note.length < 28) return item.note;
  if (item.url) {
    try {
      const u = new URL(item.url);
      const tail = u.pathname && u.pathname !== "/" ? u.pathname.slice(0, 18) : "";
      return u.hostname.replace(/^www\./, "") + tail;
    } catch {
      return item.url.slice(0, 28);
    }
  }
  return item.id.slice(0, 20);
}
