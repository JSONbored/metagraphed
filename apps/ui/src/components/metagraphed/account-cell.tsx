import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";
import { EntityHoverCard } from "./entity-hover-card";
import { isValidSs58 } from "@/lib/metagraphed/accounts";
import { shortHash } from "@/lib/metagraphed/blocks";

/**
 * Renders an ss58 account value as a truncated `/accounts/$ss58` link wrapped in
 * the account hover-card preview — the treatment ss58 addresses get elsewhere in
 * the app. When the value is missing or not a valid ss58, renders `fallback`
 * (each table keeps its own prior rendering there). Shared by the blocks and
 * extrinsics explorer tables so the cell markup lives in one place.
 */
export function AccountCell({ ss58, fallback }: { ss58?: string | null; fallback: ReactNode }) {
  if (ss58 && isValidSs58(ss58)) {
    return (
      <EntityHoverCard kind="account" ss58={ss58}>
        <Link to="/accounts/$ss58" params={{ ss58 }} className="hover:underline" title={ss58}>
          {shortHash(ss58)}
        </Link>
      </EntityHoverCard>
    );
  }
  return <>{fallback}</>;
}
