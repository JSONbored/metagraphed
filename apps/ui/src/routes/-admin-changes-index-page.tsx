import { useNavigate, useSearch } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Scale, Coins, Timer } from "lucide-react";
import { StatTile } from "@jsonbored/ui-kit";
import { CallModuleExtrinsicsTable } from "@/components/metagraphed/call-module-extrinsics-table";
import { governanceConfigChangesQuery, networkParametersQuery } from "@/lib/metagraphed/queries";
import { API_BASE } from "@/lib/metagraphed/config";
import { formatNumber, formatTao } from "@/lib/metagraphed/format";
import type { GovernanceSearch } from "./chain.governance";

export function adminChangesQueryParams(search: GovernanceSearch): Record<string, string | number> {
  const queryParams: Record<string, string | number> = {
    limit: search.limit,
    offset: search.offset,
  };
  if (search.call_function) queryParams.call_function = search.call_function;
  if (search.success) queryParams.success = search.success;
  return queryParams;
}

export function NetworkParametersCard() {
  const { data: res } = useSuspenseQuery(networkParametersQuery());
  const p = res.data;
  const taoWeightPct = p.tao_weight != null ? `${(p.tao_weight * 100).toFixed(2)}%` : "—";

  return (
    <div className="mb-6">
      <div className="mg-type-micro mb-2 text-[10px] text-ink-muted">
        Current network parameters
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatTile
          icon={Scale}
          eyebrow="TaoWeight"
          value={taoWeightPct}
          hint="root-weight ratio in consensus"
        />
        <StatTile
          icon={Coins}
          eyebrow="StakeThreshold"
          value={formatTao(p.stake_threshold_tao)}
          hint="min stake to register a hotkey"
        />
        <StatTile
          icon={Timer}
          eyebrow="PendingChildKeyCooldown"
          value={formatNumber(p.pending_childkey_cooldown_blocks)}
          hint="blocks before a pending child key activates"
        />
      </div>
    </div>
  );
}

export function AdminChangesTable() {
  const search = useSearch({ from: "/chain/governance" });
  const navigate = useNavigate({ from: "/chain/governance" });
  const queryParams = adminChangesQueryParams(search);

  const setSearch = (patch: Record<string, unknown>) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }) as never,
      // Patch in-page search/filter state only; do not scroll to top on each keystroke (#3691).
      resetScroll: false,
    });

  return (
    <CallModuleExtrinsicsTable
      queryOptions={governanceConfigChangesQuery(queryParams)}
      search={{
        limit: search.limit,
        offset: search.offset,
        call_function: search.call_function,
        success: search.success,
      }}
      setSearch={setSearch}
      emptyTitle="No admin config changes indexed yet"
      emptyDescription="AdminUtils calls set subnet hyperparameters and network config — check back shortly, or open the API directly."
      emptyApiPath={`${API_BASE}/api/v1/governance/config-changes`}
    />
  );
}
