import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { SegmentedToggle } from "@jsonbored/ui-kit";

/**
 * Shared time-window state for the /subnets/:netuid detail page. Persisted
 * via the `window` search param so panels (economics tiles, sparklines,
 * price/history charts) all read from the same source of truth and the
 * selection is shareable via URL.
 *
 * Values are intentionally aligned with the /subnets list route so the
 * user's window carries over when they drill in.
 */
export type SubnetWindow = "7d" | "30d" | "90d";

export const SUBNET_WINDOWS: SubnetWindow[] = ["7d", "30d", "90d"];

export function isSubnetWindow(v: unknown): v is SubnetWindow {
  return v === "7d" || v === "30d" || v === "90d";
}

interface Ctx {
  window: SubnetWindow;
  setWindow: (w: SubnetWindow) => void;
}

const SubnetWindowCtx = createContext<Ctx | null>(null);

/**
 * URL-synced provider. Reads `?window=` from the parent route's search and
 * writes it back with `replace: true` so the browser history stays clean.
 */
export function SubnetWindowProvider({
  children,
  defaultWindow = "30d",
}: {
  children: ReactNode;
  defaultWindow?: SubnetWindow;
}) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const raw = search.window;
  const window: SubnetWindow = isSubnetWindow(raw) ? raw : defaultWindow;

  const ctx = useMemo<Ctx>(
    () => ({
      window,
      setWindow: (w) => {
        navigate({
          to: ".",
          search: (prev: Record<string, unknown>) => ({ ...prev, window: w }),
          replace: true,
          resetScroll: false,
        });
      },
    }),
    [window, navigate],
  );

  return <SubnetWindowCtx.Provider value={ctx}>{children}</SubnetWindowCtx.Provider>;
}

/**
 * Reads the shared window. Falls back to `30d` if used outside a provider so
 * standalone panels don't crash — but the URL will not update.
 */
export function useSubnetWindow(): Ctx {
  const c = useContext(SubnetWindowCtx);
  if (c) return c;
  return { window: "30d", setWindow: () => undefined };
}

/**
 * Small segmented toggle bound to the shared window. Drop into any header
 * trailing slot on the subnet detail page.
 */
export function SubnetWindowToggle({ className }: { className?: string }) {
  const { window, setWindow } = useSubnetWindow();
  return (
    <SegmentedToggle<SubnetWindow>
      className={className}
      ariaLabel="Trend window"
      value={window}
      onChange={setWindow}
      options={SUBNET_WINDOWS.map((w) => ({
        value: w,
        label: w,
        title: `Show ${w} trends`,
      }))}
    />
  );
}
