import { useRef, useState } from "react";
import { Download, Upload } from "lucide-react";
import { Panel } from "@jsonbored/ui-kit";
import {
  exportAddressLabels,
  importAddressLabels,
  useAddressLabels,
} from "@/lib/metagraphed/address-labels";

/**
 * Export/import for private address labels (#8484 requirement 5).
 *
 * Same rationale and shape conventions as `WatchlistPortability` (#8256):
 * there is no account system, so labels live in one browser's localStorage —
 * "I got a new laptop" or "I cleared site data" would otherwise silently
 * lose them. Kept as its own panel/file rather than merged into
 * `WatchlistPortability` — the two stores are independent (a set of ids vs.
 * a map of user-authored text) and #8484 asks only that the export SHAPE's
 * conventions (version + exported_at + payload) be reused, not that the two
 * features share one file.
 *
 * Import merges rather than replaces, and never overwrites a label already
 * on this device (see address-labels.ts's own `importAddressLabels` comment)
 * — the one irreversible thing this could do, and no one importing a file is
 * asking for that.
 */
export function AddressLabelPortability() {
  const { count } = useAddressLabels();
  const fileRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<string | null>(null);

  function onExport() {
    const blob = new Blob([JSON.stringify(exportAddressLabels(), null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `metagraphed-address-labels-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function onImport(file: File) {
    try {
      const added = importAddressLabels(await file.text());
      setStatus(
        added > 0
          ? `Added ${added} label${added === 1 ? "" : "s"}. Existing labels were kept.`
          : "Nothing new — every address in that file already has a label here.",
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
      title="Private address labels"
      caption={
        count > 0
          ? `${count} address${count === 1 ? "" : "es"} labeled, stored in this browser only.`
          : "Nothing labeled yet. Labels are stored in this browser only — never sent to us."
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onExport}
          disabled={count === 0}
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
