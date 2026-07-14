import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Code2, MoreHorizontal, Webhook } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@jsonbored/ui-kit";
import { useApiSourceCtx } from "@/lib/metagraphed/api-source-context";
import { SettingsPanel } from "./settings-popover";
import { WalletConnectPanel } from "./wallet-connect";

/**
 * Consolidated header actions for the mid-desktop range (lg–xl). Once the
 * mega-menu appears at `lg` there is no longer room to keep every trailing
 * icon inline without one escaping the viewport (#3985), so the secondary
 * actions — the API-source drawer, the developer-settings link, and the
 * theme / density / health controls — fold into this single "more" popover.
 * At `xl` and up the header has room again and the standalone icons return,
 * so this is rendered only in the `lg:inline-flex xl:hidden` window.
 */
export function HeaderActionsMenu() {
  const { sources, open } = useApiSourceCtx();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <Popover open={menuOpen} onOpenChange={setMenuOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="More header actions"
          title="More"
          className="inline-flex items-center justify-center rounded border border-border bg-card p-1.5 min-h-11 min-w-11 text-ink-muted hover:text-ink-strong hover:border-ink/30 transition-colors"
        >
          <MoreHorizontal className="size-3.5" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3 space-y-3">
        <div className="space-y-1">
          {sources.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                open();
              }}
              className="w-full flex items-center gap-2 rounded border border-border bg-card px-2 py-2 text-left text-[12px] text-ink hover:border-ink/30 hover:text-ink-strong transition-colors min-h-9"
            >
              <Code2 className="size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
              <span>View API source</span>
            </button>
          ) : null}
          <Link
            to="/settings"
            onClick={() => setMenuOpen(false)}
            className="w-full flex items-center gap-2 rounded border border-border bg-card px-2 py-2 text-left text-[12px] text-ink hover:border-ink/30 hover:text-ink-strong transition-colors min-h-9"
          >
            <Webhook className="size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
            <span>Developer settings</span>
          </Link>
        </div>
        <div>
          <div className="mg-label mb-1.5">Wallet</div>
          <WalletConnectPanel />
        </div>
        <SettingsPanel />
      </PopoverContent>
    </Popover>
  );
}
