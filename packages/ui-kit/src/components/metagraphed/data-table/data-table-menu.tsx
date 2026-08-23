import { useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/**
 * The one table menu (#11610): which columns are shown, the CSV of what is
 * currently sorted and filtered, and a link back to this view. It replaces
 * the separate column customizer, download button and share button every
 * list route used to carry above its table.
 */
export function DataTableMenu<Row>({
  columns,
  visibleKeys,
  onVisibleKeys,
  csv,
  filename,
  shareUrl,
  label,
}: {
  columns: ReadonlyArray<{ key: string; label: string; demote?: boolean }>;
  visibleKeys: readonly string[];
  onVisibleKeys: (keys: string[]) => void;
  csv: () => string;
  filename: string;
  shareUrl?: string;
  label: string;
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

  const download = () => {
    if (typeof document === "undefined") return;
    const blob = new Blob([csv()], { type: "text/csv;charset=utf-8" });
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
        <div className="mg-dt-menu-actions">
          <button type="button" onClick={download}>
            Download CSV
          </button>
          <button type="button" onClick={copyLink}>
            {copied ? "Link copied" : "Copy link"}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
