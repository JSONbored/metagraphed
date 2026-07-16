import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";
import { CopyButton } from "@jsonbored/ui-kit";
import { EntityHoverCard } from "./entity-hover-card";
import { isValidSs58 } from "@/lib/metagraphed/accounts";
import { shortHash } from "@/lib/metagraphed/blocks";

/**
 * Renders an ss58 account value as a truncated `/accounts/$ss58` link wrapped in
 * the account hover-card preview — the treatment ss58 addresses get elsewhere in
 * the app — plus a copy button, matching the block-hash cell's inline idiom
 * (blocks.index.tsx). When the value is missing or not a valid ss58, renders
 * `fallback` (each table keeps its own prior rendering there). `/accounts/$ss58`
 * is the app's one lookup route for any ss58 value regardless of whether it's a
 * hotkey or coldkey, so this covers both. Shared by the blocks and extrinsics
 * explorer tables so the cell markup lives in one place.
 */
export function AccountAddress({
  ss58,
  fallback,
  keep,
  copyButtonClassName,
  compact,
}: {
  ss58?: string | null;
  fallback: ReactNode;
  /** Chars kept at each end before the ellipsis (passed to shortHash). Defaults to 6. */
  keep?: number;
  copyButtonClassName?: string;
  /** Forwarded to the inner CopyButton — pass true inside a dense table/list row. See CopyButton's `compact` doc. */
  compact?: boolean;
}) {
  if (ss58 && isValidSs58(ss58)) {
    return (
      <span className="inline-flex items-center gap-1 min-w-0">
        <EntityHoverCard kind="account" ss58={ss58}>
          <Link to="/accounts/$ss58" params={{ ss58 }} className="hover:underline" title={ss58}>
            {shortHash(ss58, keep)}
          </Link>
        </EntityHoverCard>
        <CopyButton value={ss58} label="account" className={copyButtonClassName} compact={compact} />
      </span>
    );
  }
  return <>{fallback}</>;
}
