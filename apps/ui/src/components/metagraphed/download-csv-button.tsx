import { Download } from "lucide-react";
import { classNames } from "@/lib/metagraphed/format";

interface Props {
  /** API list endpoint URL (with any filter/sort query params), excluding `format=csv`. */
  url: string;
  /** Optional hint only — the server sets the filename via Content-Disposition. */
  filename?: string;
  label?: string;
  className?: string;
}

/** Append `format=csv` to an API URL, preserving existing query params. */
export function buildCsvDownloadUrl(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("format", "csv");
  return parsed.toString();
}

export function DownloadCsvButton({ url, label = "Download CSV", className }: Props) {
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
        "inline-flex items-center gap-1.5 rounded border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-ink hover:border-ink/30 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <Download className="size-3 text-ink-muted" aria-hidden />
      {label}
    </button>
  );
}
