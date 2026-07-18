import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Keyboard } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  Kbd,
} from "@jsonbored/ui-kit";
import { classNames } from "@/lib/metagraphed/format";

const GOTO: Array<{ keys: string; to: string; label: string }> = [
  { keys: "g s", to: "/subnets", label: "Subnets" },
  { keys: "g u", to: "/surfaces", label: "Surfaces" },
  { keys: "g e", to: "/endpoints", label: "Endpoints" },
  { keys: "g p", to: "/providers", label: "Providers" },
  { keys: "g h", to: "/health", label: "Health" },
  { keys: "g x", to: "/schemas", label: "Schemas" },
  { keys: "g g", to: "/gaps", label: "Gaps" },
];

export function ShortcutsPopover() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const lastG = useRef<number>(0);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tgt = e.target as HTMLElement | null;
      const inField =
        tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable);
      if (inField) return;
      if (e.key === "?" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      const now = Date.now();
      if (e.key === "g") {
        lastG.current = now;
        return;
      }
      if (now - lastG.current < 900) {
        const found = GOTO.find((g) => g.keys.endsWith(e.key));
        if (found) {
          e.preventDefault();
          lastG.current = 0;
          navigate({ to: found.to });
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Keyboard shortcuts"
              className={classNames(
                "hidden md:inline-flex fixed z-40 bottom-5 left-5 md:bottom-7 md:left-7",
                "items-center justify-center rounded-full border border-border bg-card/95 backdrop-blur",
                "size-10 text-ink-muted shadow-[0_8px_24px_-12px_rgba(0,0,0,0.35)]",
                "hover:border-accent/60 hover:text-accent transition-colors",
              )}
            >
              <Keyboard className="size-4" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="right" className="text-[11px]">
          Keyboard shortcuts (?)
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="start" side="top" className="w-80 p-4">
        <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted mb-3">
          Shortcuts
        </div>
        <ul className="space-y-1.5 text-[12px]">
          <Row label="Focus search">
            <Kbd>/</Kbd>
            <span className="text-ink-muted">or</span>
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </Row>
          <Row label="Toggle this panel">
            <Kbd>?</Kbd>
          </Row>
          <Row label="Close menus / panels">
            <Kbd>Esc</Kbd>
          </Row>
          <Row label="Prev / next block (on block pages)">
            <Kbd>←</Kbd>
            <Kbd>→</Kbd>
          </Row>
        </ul>
        <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted mt-4 mb-2">
          Go to
        </div>
        <ul className="space-y-1.5 text-[12px]">
          {GOTO.map((g) => (
            <Row key={g.keys} label={g.label}>
              {g.keys.split(" ").map((k, i) => (
                <Kbd key={i}>{k}</Kbd>
              ))}
            </Row>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <li className="flex items-center justify-between gap-2">
      <span className="text-ink">{label}</span>
      <span className="inline-flex items-center gap-1">{children}</span>
    </li>
  );
}
