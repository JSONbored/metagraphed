import { Download } from "lucide-react";
import { classNames } from "@/lib/format";

interface Props {
  /** API list endpoint URL (with any filter/sort query params), excluding `format=csv`. */
  url: string;
  /** Optional hint only — the server sets the filename via Content-Disposition. */
  filename?: string;
  label?: string;
  className?: string;
  /** Borderless variant for grouping inside an `ActionBar` segmented pill. */
  bare?: boolean;
}

/** Append `format=csv` to an API URL, preserving existing query params. */
export function buildCsvDownloadUrl(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("format", "csv");
  return parsed.toString();
}

export function DownloadCsvButton({
  url,
  label = "Download CSV",
  className,
  bare,
}: Props) {
  const exportUrl = buildCsvDownloadUrl(url);

  const onClick = () => {
    window.location.href = exportUrl;
  };

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={classNames(
        bare
          ? "inline-flex items-center gap-1.5 rounded px-2 py-1 min-h-8 text-[11px] font-medium text-ink-muted hover:text-ink-strong hover:bg-surface transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          : // rounded-full matches the pill idiom shared by SectionBadge/FilterChip/
            // other compact header controls it commonly sits next to — a plain
            // `rounded` rectangle reads as a mismatched shape beside a pill.
            "inline-flex items-center gap-1.5 rounded-full border border-border bg-card p-1.5 text-[11px] font-medium text-ink hover:border-ink/30 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-2.5 sm:py-1",
        className,
      )}
    >
      <Download className="size-3 text-ink-muted" aria-hidden />
      {/* Icon-only below `sm` — a text label is the first thing to drop when a
          button shares a header row with other controls on a narrow viewport;
          the icon + aria-label/title keep it identifiable either way. */}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
