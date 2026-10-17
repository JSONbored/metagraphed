import { useLayoutEffect, useRef, useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/**
 * The one table menu (#11610): which columns are shown, how many rows a page
 * holds, the CSV of what is currently sorted and filtered, and a link back to
 * this view. It replaces the separate column customizer, `per page` select,
 * download button and share button every list route used to carry above its
 * table.
 *
 * Page size is here rather than beside the pager (#11620) for the same reason
 * the column set is: it is a preference about how the table is drawn, asked
 * once and rarely changed, and a control that permanently occupies the
 * caption row makes every list carry a question the reader did not ask.
 */
export function DataTableMenu<Row>({
  columns,
  visibleKeys,
  onVisibleKeys,
  csv,
  filename,
  shareUrl,
  label,
  pageSize,
  pageSizes,
  onPageSize,
}: {
  columns: ReadonlyArray<{ key: string; label: string; demote?: boolean }>;
  visibleKeys: readonly string[];
  onVisibleKeys: (keys: string[]) => void;
  csv: (signal: AbortSignal) => string | Promise<string>;
  filename: string;
  shareUrl?: string;
  label: string;
  /** Current rows-per-page; omit `onPageSize` to leave the control out. */
  pageSize?: number;
  pageSizes?: readonly number[];
  onPageSize?: (size: number) => void;
  /** Only here so the generic parameter is used by the props type. */
  rows?: readonly Row[];
}) {
  const [copied, setCopied] = useState(false);

  const toggle = (key: string) => {
    const next = visibleKeys.includes(key)
      ? visibleKeys.filter((k) => k !== key)
      : columns
          .filter((c) => c.key === key || visibleKeys.includes(c.key))
          .map((c) => c.key);
    // Never leave a table with no columns.
    if (next.length > 0) onVisibleKeys(next);
  };

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const exportRequest = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    setExporting(false);
    setExportError(null);
    return () => {
      exportRequest.current?.abort();
      exportRequest.current = null;
    };
  }, [csv]);
  const download = async () => {
    if (typeof document === "undefined") return;
    if (exportRequest.current) return;
    const controller = new AbortController();
    exportRequest.current = controller;
    setExporting(true);
    setExportError(null);
    try {
      const contents = await csv(controller.signal);
      if (controller.signal.aborted || exportRequest.current !== controller) return;
      const blob = new Blob([contents], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${filename
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")}.csv`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      if (!controller.signal.aborted) {
        setExportError(error instanceof Error ? error.message : "CSV export failed. Try again.");
      }
    } finally {
      if (exportRequest.current === controller) {
        exportRequest.current = null;
        setExporting(false);
      }
    }
  };

  const copyLink = () => {
    const url =
      shareUrl ?? (typeof window === "undefined" ? "" : window.location.href);
    if (!url) return;
    void navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="mg-dt-menu-trigger"
          aria-label={`${label} options`}
        >
          <span aria-hidden="true">⋯</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="mg-dt-menu">
        <p className="mg-dt-menu-heading">Columns</p>
        <ul className="mg-dt-menu-columns">
          {columns.map((column) => (
            <li key={column.key}>
              <label>
                <input
                  type="checkbox"
                  checked={visibleKeys.includes(column.key)}
                  onChange={() => toggle(column.key)}
                />
                <span>{column.label}</span>
              </label>
            </li>
          ))}
        </ul>
        {onPageSize && pageSizes && pageSizes.length > 0 ? (
          <>
            <p className="mg-dt-menu-heading">Rows per page</p>
            <div
              className="mg-dt-menu-sizes"
              role="group"
              aria-label={`${label} rows per page`}
            >
              {pageSizes.map((size) => (
                <button
                  key={size}
                  type="button"
                  aria-pressed={size === pageSize}
                  onClick={() => onPageSize(size)}
                >
                  {size}
                </button>
              ))}
            </div>
          </>
        ) : null}
        <div className="mg-dt-menu-actions">
          <button type="button" onClick={() => void download()} disabled={exporting}>
            {exporting ? "Preparing CSV…" : "Download CSV"}
          </button>
          <button type="button" onClick={copyLink}>
            {copied ? "Link copied" : "Copy link"}
          </button>
        </div>
        {exportError ? <p role="alert">{exportError}</p> : null}
      </PopoverContent>
    </Popover>
  );
}
