import { useState } from "react";
import { Download } from "lucide-react";
import { getApiBase } from "@/lib/metagraphed/config";
import { triggerCsvDownload } from "@/lib/metagraphed/csv-export";
import { classNames } from "@/lib/metagraphed/format";

interface Props {
  /** Filtered/sorted list endpoint; `format=csv` is appended on click. */
  url: string;
  /** Optional client-side download hint; server Content-Disposition still wins. */
  filename?: string;
  label?: string;
  className?: string;
}

export function DownloadCsvButton({ url, filename, label = "Download CSV", className }: Props) {
  const [announcement, setAnnouncement] = useState("");

  const onClick = () => {
    if (typeof window === "undefined") return;
    triggerCsvDownload(url, getApiBase(), filename);
    setAnnouncement("CSV download started");
    window.setTimeout(() => setAnnouncement(""), 2000);
  };

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        title={label}
        className={classNames(
          "inline-flex items-center gap-1.5 rounded border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-ink hover:border-ink/30 transition-colors",
          className,
        )}
      >
        <Download className="size-3" aria-hidden />
        {label}
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </>
  );
}
