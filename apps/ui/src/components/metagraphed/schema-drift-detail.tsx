import { useEffect, useRef } from "react";
import { Link } from "@tanstack/react-router";
import { Copy, Check, ExternalLink as ExternalIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ExternalLink,
  InfoTooltip,
} from "@jsonbored/ui-kit";
import { SchemaSnapshotSummary } from "@/components/metagraphed/schema-snapshot-summary";
import { useCopy } from "@/hooks/use-copy";
import { formatFreshness, formatFreshnessAbsolute } from "@/lib/metagraphed/freshness";
import type { SchemaInfo } from "@/lib/metagraphed/types";
import { readKey, readString } from "@/lib/metagraphed/read-key";

interface Props {
  schema: SchemaInfo | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called when the user wants to drill into the full explorer for this schema. */
  onOpenInExplorer?: (id: string) => void;
}

/** #6555: whether a captured opener element is still worth restoring focus to
 *  (present and still in the document) — pure so it can be unit-tested. */
export function shouldRestoreFocus(el: HTMLElement | null): el is HTMLElement {
  return el != null && el.isConnected;
}

/**
 * Modal that explains what changed in a drifting schema: a compact field/line
 * diff, a derived compatibility-impact chip row, and evidence links so the
 * user can verify against the underlying snapshots.
 */
export function SchemaDriftDetail({ schema, open, onOpenChange, onOpenInExplorer }: Props) {
  // #6555: this Dialog is driven by a URL search param and has no in-tree
  // <DialogTrigger>, so Radix has no trigger to auto-restore focus to on close
  // and drops it to <body>. Mirror api-drawer.tsx (#6418): record the element
  // focused when the dialog opens, and restore it in onCloseAutoFocus.
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) {
      restoreFocusRef.current = (document.activeElement as HTMLElement | null) ?? null;
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-3xl"
        onCloseAutoFocus={(event) => {
          const el = restoreFocusRef.current;
          if (shouldRestoreFocus(el)) {
            event.preventDefault();
            el.focus();
          }
        }}
      >
        {schema ? (
          <DriftBody
            schema={schema}
            onOpenInExplorer={onOpenInExplorer}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function DriftBody({
  schema,
  onOpenInExplorer,
  onClose,
}: {
  schema: SchemaInfo;
  onOpenInExplorer?: (id: string) => void;
  onClose: () => void;
}) {
  const { copied, copy } = useCopy({ label: "schema url" });

  // No backend /schemas/{id}/diff endpoint exists (404). The drift summary is
  // derived inline from the schema record's own snapshot + hash + previous_hash
  // + drift_status, so the modal never opens into a guaranteed ErrorState.

  const freshLine = formatFreshness(schema.updated_at, "snapshot");
  const freshAbs = formatFreshnessAbsolute(schema.updated_at);

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex flex-wrap items-center gap-2">
          <span>{schema.name ?? schema.id}</span>
          <span className="inline-flex items-center rounded border border-health-warn/40 bg-health-warn/10 px-2 py-0.5 text-10 text-health-warn">
            drift
          </span>
          {schema.netuid != null ? (
            <Link
              to="/subnets/$netuid"
              params={{ netuid: schema.netuid }}
              className="text-10 text-accent hover:underline"
              onClick={onClose}
            >
              SN{schema.netuid}
            </Link>
          ) : null}
        </DialogTitle>
        <DialogDescription>
          <span className="text-11">
            {freshLine ?? "snapshot"}
            {freshAbs ? ` · last checked ${freshAbs}` : ""}
          </span>
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        <SchemaSnapshotSummary schema={schema} />

        <EvidenceSection schema={schema} copied={copied} onCopy={copy} />
      </div>

      <DialogFooter className="gap-2 sm:gap-2">
        {onOpenInExplorer ? (
          <button
            type="button"
            onClick={() => {
              onOpenInExplorer(schema.id);
              onClose();
            }}
            className="inline-flex items-center gap-1.5 rounded border border-accent/40 bg-primary-soft px-3 py-1.5 text-11 text-accent-text hover:bg-primary-soft/80"
          >
            open in explorer
          </button>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          className="inline-flex items-center gap-1.5 rounded border border-border bg-paper px-3 py-1.5 text-11 text-ink-muted hover:text-ink-strong"
        >
          close
        </button>
      </DialogFooter>
    </>
  );
}

function EvidenceSection({
  schema,
  copied,
  onCopy,
}: {
  schema: SchemaInfo;
  copied: boolean;
  onCopy: (v: string) => void;
}) {
  const links: Array<{ label: string; href: string }> = [];
  for (const key of ["url", "snapshot_url", "prev_snapshot_url", "artifact_path"]) {
    const v = readString(schema, key);
    if (v !== undefined && v.length > 0) {
      links.push({ label: key.replace(/_/g, " "), href: v });
    }
  }
  const evidence = readKey(schema, "evidence");
  if (Array.isArray(evidence)) {
    for (const entry of evidence) {
      if (typeof entry !== "object" || entry === null) continue;
      const url = readString(entry, "url");
      if (url?.startsWith("http")) {
        links.push({ label: readString(entry, "source") ?? "evidence", href: url });
      }
    }
  }

  if (links.length === 0) return null;

  return (
    <div className="rounded border border-border p-3">
      <div className="mb-2 flex items-center gap-2 text-13 text-ink-muted">
        evidence &amp; sources
        <InfoTooltip label="Where the snapshot diff was derived from. Open or copy these to verify the change against the source." />
      </div>
      <ul className="space-y-1.5">
        {links.map((l) => (
          <li key={l.href} className="flex items-center gap-2 text-11 text-ink">
            <span className="shrink-0 rounded border border-border bg-paper px-1.5 py-0.5 text-13 text-ink-muted">
              {l.label}
            </span>
            {l.href.startsWith("http") ? (
              <ExternalLink href={l.href} className="truncate text-11">
                <span className="inline-flex items-center gap-1">
                  <ExternalIcon className="size-3" />
                  <span className="truncate">{l.href}</span>
                </span>
              </ExternalLink>
            ) : (
              <span className="truncate text-ink-muted">{l.href}</span>
            )}
            <button
              type="button"
              onClick={() => onCopy(l.href)}
              className="ml-auto inline-flex items-center gap-1 rounded border border-border bg-paper px-1.5 py-0.5 text-10 text-ink-muted hover:text-ink-strong"
              aria-label={`Copy ${l.label}`}
            >
              {copied ? <Check className="size-3 text-health-ok" /> : <Copy className="size-3" />}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
