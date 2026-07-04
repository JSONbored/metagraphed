import { classNames } from "@/lib/metagraphed/format";
import { CATEGORY_LABEL, type EndpointCategory } from "@/lib/metagraphed/endpoint-pool";

interface Props {
  value: EndpointCategory | "all";
  counts: Partial<Record<EndpointCategory | "all", number>>;
  onChange: (v: EndpointCategory | "all") => void;
}

const ORDER: Array<EndpointCategory | "all"> = ["all", "rpc", "wss", "api", "sse", "data", "other"];

export function EndpointKindTabs({ value, counts, onChange }: Props) {
  return (
    <div
      role="tablist"
      aria-label="Filter endpoints by kind"
      className="flex flex-wrap items-center gap-1.5"
    >
      {ORDER.map((k) => {
        const active = value === k;
        const label = k === "all" ? "All" : CATEGORY_LABEL[k];
        const count = counts[k];
        if (k !== "all" && (count ?? 0) === 0) return null;
        return (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(k)}
            className={classNames(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest transition-colors",
              active
                ? "border-accent/60 bg-accent/15 text-ink-strong"
                : "border-border bg-card text-ink-muted hover:text-ink-strong hover:border-ink/30",
            )}
          >
            {label}
            {count != null ? (
              <span
                className={classNames(
                  "rounded-sm px-1 tabular-nums text-[10px]",
                  active ? "bg-paper/40 text-ink-strong" : "bg-surface/60 text-ink-muted",
                )}
              >
                {count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
