import { useEffect, useState } from "react";
import { Kbd } from "@jsonbored/ui-kit";
import { Panel } from "@/components/metagraphed/primitives";

const SHORTCUTS: Array<{ keys: string[]; label: string }> = [
  { keys: ["J", "←"], label: "Previous block" },
  { keys: ["K", "→"], label: "Next block" },
  { keys: ["G"], label: "Back to blocks feed" },
  { keys: ["E"], label: "Focus extrinsics section" },
  { keys: ["V"], label: "Focus events section" },
  { keys: ["R"], label: "Copy block reference" },
  { keys: ["?"], label: "Show this cheatsheet" },
];

/**
 * Global "?" cheatsheet for the block detail page. Rendered as a lightweight
 * flat dialog (no shadow — matches Bone & Ink) with a focus trap on the close
 * button. Escape closes.
 */
export function ShortcutsDialog({ blockRef }: { blockRef: string }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tgt = e.target as HTMLElement | null;
      const inField =
        tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable);
      if (inField) return;
      if (e.key === "?" || (e.shiftKey && e.key === "/")) {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (e.key === "Escape" && open) {
        e.preventDefault();
        setOpen(false);
        return;
      }
      if ((e.key === "e" || e.key === "E") && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const el = document.getElementById("extrinsics");
        if (el) {
          e.preventDefault();
          el.scrollIntoView({ behavior: "smooth", block: "start" });
          (el.querySelector("h2, [data-section-heading]") as HTMLElement | null)?.focus?.();
        }
        return;
      }
      if ((e.key === "v" || e.key === "V") && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const el = document.getElementById("events");
        if (el) {
          e.preventDefault();
          el.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        return;
      }
      if ((e.key === "r" || e.key === "R") && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        void navigator.clipboard?.writeText(blockRef).catch(() => {});
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, blockRef]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal
      aria-labelledby="mg-shortcut-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-strong/30 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <Panel as="div" flush className="w-full max-w-md">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 id="mg-shortcut-title" className="mg-type-micro text-ink-muted">
            Keyboard shortcuts
          </h2>
          <button
            type="button"
            autoFocus
            onClick={() => setOpen(false)}
            className="mg-focus-ring rounded px-2 py-1 mg-type-micro text-ink-muted hover:text-ink-strong"
          >
            Esc
          </button>
        </div>
        <dl className="divide-y divide-border/60">
          {SHORTCUTS.map((s) => (
            <div key={s.label} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <dt className="text-[13px] text-ink">{s.label}</dt>
              <dd className="flex items-center gap-1">
                {s.keys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </Panel>
    </div>
  );
}
