import { useRef, useState } from "react";
import { Download, Upload } from "lucide-react";
import { Panel } from "@jsonbored/ui-kit";
import {
  exportWatchlists,
  importWatchlists,
  useWatchlist,
  WATCHLIST_KINDS,
  type WatchlistKind,
} from "@/lib/metagraphed/watchlist";

/**
 * Export/import for the watchlist (#8256).
 *
 * There is no account system and none is wanted, so stars live in one
 * browser's localStorage — which means "I got a new laptop" or "I cleared site
 * data" silently loses them. A JSON file is the whole portability story: no
 * server, no sync, no account, and the user can read exactly what's in it.
 *
 * Import merges rather than replaces. Overwriting the stars on the device
 * you're importing *to* is the one irreversible thing this could do, and no
 * one asking to import a file is asking for that.
 */
export function WatchlistPortability() {
  // Subscribing to all three kinds keeps the counts live as a merge lands.
  const counts: Record<WatchlistKind, number> = {
    subnet: useWatchlist("subnet").count,
    validator: useWatchlist("validator").count,
    account: useWatchlist("account").count,
  };
  const total = WATCHLIST_KINDS.reduce((n, k) => n + counts[k], 0);
  const fileRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<string | null>(null);

  function onExport() {
    const blob = new Blob([JSON.stringify(exportWatchlists(), null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `metagraphed-watchlist-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function onImport(file: File) {
    try {
      const added = importWatchlists(await file.text());
      const parts = WATCHLIST_KINDS.filter((k) => added[k] > 0).map(
        (k) => `${added[k]} ${k}${added[k] === 1 ? "" : "s"}`,
      );
      setStatus(
        parts.length > 0
          ? `Added ${parts.join(", ")}. Existing stars were kept.`
          : "Nothing new — every entry in that file was already starred here.",
      );
    } catch (e) {
      setStatus(
        e instanceof Error ? `Couldn't import: ${e.message}` : "Couldn't import that file.",
      );
    }
  }

  return (
    <Panel
      as="section"
      title="Watchlist"
      caption={
        total > 0
          ? `${counts.subnet} subnets · ${counts.validator} validators · ${counts.account} accounts, stored in this browser only.`
          : "Nothing starred yet. Stars are stored in this browser only — never sent to us."
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onExport}
          disabled={total === 0}
          className="inline-flex min-h-9 items-center gap-1.5 rounded border border-border bg-card px-2.5 py-1 mg-type-caption font-medium text-ink-strong transition-colors hover:border-accent/40 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Download className="size-3.5" aria-hidden />
          Export JSON
        </button>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="inline-flex min-h-9 items-center gap-1.5 rounded border border-border bg-card px-2.5 py-1 mg-type-caption font-medium text-ink-strong transition-colors hover:border-accent/40"
        >
          <Upload className="size-3.5" aria-hidden />
          Import JSON
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Reset so re-picking the same file fires `change` again.
            e.target.value = "";
            if (file) void onImport(file);
          }}
        />
      </div>
      {status ? (
        <p className="mt-2 mg-type-caption text-ink-muted" role="status">
          {status}
        </p>
      ) : null}
    </Panel>
  );
}
