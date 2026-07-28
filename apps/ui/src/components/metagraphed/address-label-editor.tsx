import { useState } from "react";
import { Pencil, Tag, Trash2, UserRound } from "lucide-react";
import { Popover, PopoverTrigger } from "@jsonbored/ui-kit";
import { ClampedPopoverContent } from "./clamped-popover-content";
import {
  useAddressLabels,
  MAX_NAME_LENGTH,
  MAX_NOTE_LENGTH,
} from "@/lib/metagraphed/address-labels";
import { classNames } from "@/lib/metagraphed/format";

const inputCls =
  "w-full rounded border border-border bg-card px-2.5 py-1.5 mg-type-caption-lg text-ink placeholder:text-ink-muted focus:outline-none focus:border-ink/30";

/**
 * The private-label editor popover (#8484): both of the feature's entry
 * points — the inline detail-context pencil on `AddressDisplay` and the
 * connected-wallet "Label this as mine" affordance — render this same form,
 * only the trigger differs.
 *
 * Privacy (#8484 requirement 6): the whole popover carries `ph-no-capture`,
 * the same PostHog session-replay exclusion marker the one-time secret-reveal
 * panels use (api-keys-manager.tsx, webhook-subscription-manager.tsx,
 * watch-alert-form.tsx) — a private label is the user's own name for their
 * own wallet, the closest thing to PII this app renders, and it appears on
 * pages `analytics.ts`'s route-level blocklist does NOT cover (account
 * pages, transfer lists), so element-level exclusion is the only thing
 * standing between it and a recording. Nothing here is transmitted anywhere
 * — see address-labels.ts's own header comment.
 */
export function AddressLabelEditor({
  ss58,
  defaultName,
  trigger = "icon",
}: {
  ss58: string;
  /** Pre-fill for a fresh label — the connected wallet extension's own
   * account name, when the caller has it (#8484 requirement 3a). */
  defaultName?: string;
  /** "icon": a small pencil/tag button for inline detail contexts (#8484
   * requirement 3b). "button": a full-width text button for the
   * connected-wallet panel (#8484 requirement 3a). */
  trigger?: "icon" | "button";
}) {
  const { getLabel, setLabel, removeLabel } = useAddressLabels();
  const existing = getLabel(ss58);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(existing?.name ?? defaultName ?? "");
  const [note, setNote] = useState(existing?.note ?? "");

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      // Reset to the current stored value (or the prefill) every time the
      // popover opens, so a previous unsaved edit doesn't linger.
      setName(existing?.name ?? defaultName ?? "");
      setNote(existing?.note ?? "");
    }
  }

  function onSave() {
    setLabel(ss58, name, note);
    setOpen(false);
  }

  function onRemove() {
    removeLabel(ss58);
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        {trigger === "icon" ? (
          <button
            type="button"
            aria-label={existing ? "Edit your private label" : "Label this address as yours"}
            title={
              existing ? "Edit your private label" : "Label this address — visible only to you"
            }
            className="ph-no-capture inline-flex size-6 shrink-0 items-center justify-center rounded text-ink-muted transition-colors hover:text-ink-strong hover:bg-surface/60"
          >
            {existing ? (
              <UserRound className="size-3.5" aria-hidden="true" />
            ) : (
              <Pencil className="size-3.5" aria-hidden="true" />
            )}
          </button>
        ) : (
          <button
            type="button"
            className="ph-no-capture w-full inline-flex items-center justify-center gap-1.5 rounded border border-border bg-card px-3 py-1.5 mg-type-caption font-medium text-ink-strong hover:border-ink/30 transition-colors"
          >
            <Tag className="size-3.5" aria-hidden="true" />
            {existing ? "Edit your label" : "Label this as mine"}
          </button>
        )}
      </PopoverTrigger>
      <ClampedPopoverContent align="start" className="ph-no-capture w-72 p-3">
        <div className="space-y-3">
          <div>
            <div className="mg-label mb-1">Private label</div>
            <p className="mg-type-caption text-ink-muted">
              Visible only to you, in this browser. Never sent to us — see /settings for
              export/import.
            </p>
          </div>
          <label className="block">
            <span className="mb-1 block mg-type-caption text-ink-muted">Name</span>
            <input
              type="text"
              autoFocus
              value={name}
              maxLength={MAX_NAME_LENGTH}
              placeholder="e.g. Main coldkey"
              onChange={(e) => setName(e.target.value)}
              className={inputCls}
            />
          </label>
          <label className="block">
            <span className="mb-1 block mg-type-caption text-ink-muted">Note (optional)</span>
            <textarea
              value={note}
              maxLength={MAX_NOTE_LENGTH}
              rows={2}
              placeholder="e.g. Ledger, cold storage"
              onChange={(e) => setNote(e.target.value)}
              className={classNames(inputCls, "resize-none")}
            />
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onSave}
              disabled={!name.trim()}
              className="flex-1 inline-flex items-center justify-center rounded border border-ink-strong/40 bg-surface px-3 py-1.5 mg-type-caption font-medium text-ink-strong transition-colors hover:bg-surface/80 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Save
            </button>
            {existing ? (
              <button
                type="button"
                aria-label="Remove private label"
                title="Remove private label"
                onClick={onRemove}
                className="inline-flex items-center justify-center rounded border border-border bg-card p-1.5 text-ink-muted transition-colors hover:text-health-down hover:border-health-down/40"
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </div>
      </ClampedPopoverContent>
    </Popover>
  );
}
