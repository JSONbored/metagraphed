import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** Complete, checked catalog walks belong to the catalog routes, not the shared table. */
export function CatalogExportAction<Row>({
  loadRows,
  formatRows,
  filename,
  children,
}: {
  loadRows: (signal: AbortSignal) => Promise<readonly Row[]>;
  formatRows: (rows: readonly Row[]) => string;
  filename: string;
  children?: ReactNode;
}) {
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
  }, [loadRows, formatRows, filename]);

  const download = async () => {
    if (typeof document === "undefined" || exportRequest.current) return;
    const controller = new AbortController();
    exportRequest.current = controller;
    setExporting(true);
    setExportError(null);
    try {
      // Start synchronously so the collector captures this click's API origin.
      const rows = await loadRows(controller.signal);
      if (controller.signal.aborted || exportRequest.current !== controller) return;
      const contents = formatRows(rows);
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

  return (
    <>
      <div className="mg-dt-menu-actions">
        <button type="button" onClick={download} disabled={exporting}>
          {exporting ? "Preparing CSV…" : "Download CSV"}
        </button>
        {children}
      </div>
      {exportError ? <p role="alert">{exportError}</p> : null}
    </>
  );
}
