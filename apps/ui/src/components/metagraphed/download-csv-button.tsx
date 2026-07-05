import { Download } from "lucide-react";
import { classNames } from "@/lib/metagraphed/format";
import { buildCsvDownloadUrl, startCsvDownload, type QueryParams } from "@/lib/metagraphed/client";

interface Props {
  /** API path, e.g. `/api/v1/subnets`. */
  path: string;
  /** Query params to preserve alongside `format=csv` (sort, filters, limit, fields, …). */
  params?: QueryParams;
  /** Optional download filename hint for the browser. */
  filename?: string;
  label?: string;
  className?: string;
}

/**
 * Reusable CSV export trigger for list/table pages. Wires the backend's
 * standardized `?format=csv` download without page-specific layout.
 */
export function DownloadCsvButton({
  path,
  params,
  filename,
  label = "Download CSV",
  className,
}: Props) {
  const onClick = () => {
    startCsvDownload(buildCsvDownloadUrl(path, params), filename);
  };

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${label} for the current filters and sort`}
      title={`${label} for the current filters and sort`}
      className={classNames(
        "inline-flex items-center gap-1.5 rounded border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-ink hover:border-ink/30 transition-colors",
        className,
      )}
    >
      <Download className="size-3 text-ink-muted" aria-hidden />
      {label}
    </button>
  );
}
