import { Download } from "lucide-react";
import { downloadCsvFromUrl } from "@/lib/metagraphed/csv-export";
import { classNames } from "@/lib/metagraphed/format";

export interface DownloadCsvButtonProps {
  /** API endpoint to export (callers pass the already-filtered list URL). */
  url: string;
  /** Optional hint only — the server sets Content-Disposition via csvFilename(). */
  filename?: string;
  label?: string;
  className?: string;
}

/** Presentational CSV export trigger — not wired into any page yet (#3403–#3409). */
export function DownloadCsvButton({
  url,
  filename,
  label = "Download CSV",
  className,
}: DownloadCsvButtonProps) {
  const title = filename ? `${label} (${filename})` : label;
  return (
    <button
      type="button"
      onClick={() => downloadCsvFromUrl(url)}
      aria-label={label}
      title={title}
      className={classNames(
        "inline-flex items-center gap-1.5 rounded border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-ink hover:border-ink/30 transition-colors",
        className,
      )}
    >
      <Download className="size-3" aria-hidden />
      {label}
    </button>
  );
}
