import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { classNames } from "@/lib/metagraphed/format";

const PREVIEW_COUNT = 24;

/** The slice of tools to render: everything once expanded, a fixed preview otherwise. */
export function visibleTools<T>(tools: T[], open: boolean): T[] {
  return open ? tools : tools.slice(0, PREVIEW_COUNT);
}

/**
 * The MCP server's tool catalog as wrapped, individually-scannable chips
 * instead of one long dot-joined string — collapsed to a preview with a
 * "Show all N tools" toggle once the list is long (mirrors the expand
 * convention in endpoints-glance.tsx).
 */
export function McpToolsList({ tools }: { tools: { name: string; title?: string }[] }) {
  const [open, setOpen] = useState(false);
  const hasMore = tools.length > PREVIEW_COUNT;

  return (
    <div className="mt-2">
      <div className="flex flex-wrap gap-1.5">
        {visibleTools(tools, open).map((t) => (
          <span
            key={t.name}
            title={t.title}
            className="inline-flex items-center rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[10px] text-ink-muted"
          >
            {t.name}
          </span>
        ))}
      </div>
      {hasMore ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={classNames(
            "mt-2 inline-flex items-center gap-1 font-mono text-[10px] text-ink-muted",
            "hover:text-accent transition-colors",
          )}
        >
          {open ? (
            <>
              <ChevronUp className="size-3" /> Show fewer
            </>
          ) : (
            <>
              <ChevronDown className="size-3" /> Show all {tools.length} tools
            </>
          )}
        </button>
      ) : null}
    </div>
  );
}
