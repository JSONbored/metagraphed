import { useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { TimeAgo } from "@jsonbored/ui-kit";
import { Panel } from "@/components/metagraphed/primitives";
import { AddressDisplay } from "@/components/metagraphed/address-display";
import { CallModuleExtrinsicsTable } from "@/components/metagraphed/call-module-extrinsics-table";
import { StatUnavailable } from "@/components/metagraphed/states";
import { sudoCallsQuery, sudoKeyQuery } from "@/lib/metagraphed/queries";
import { statPhase } from "@/lib/metagraphed/stat-phase";
import { API_BASE } from "@/lib/metagraphed/config";
import type { GovernanceSearch } from "./chain.governance";

export function sudoQueryParams(search: GovernanceSearch): Record<string, string | number> {
  const queryParams: Record<string, string | number> = {
    limit: search.limit,
    offset: search.offset,
  };
  if (search.call_function) queryParams.call_function = search.call_function;
  if (search.success) queryParams.success = search.success;
  return queryParams;
}

/**
 * Current Sudo key, read live over RPC (#8291).
 *
 * This was a masthead KPI on the old /sudo page. The hub owns the masthead
 * now, so it renders as its own card rather than being dropped — it is the one
 * piece of live state on this tab, and the call log below is meaningless
 * without knowing who currently holds the key.
 *
 * Non-blocking by design (mirrors accounts.$ss58's balance fetch): a slow or
 * failed RPC must never stall or error the artifact-backed table.
 */
export function SudoKeyCard() {
  const keyResult = useQuery(sudoKeyQuery());
  const phase = statPhase(keyResult);
  const hotkey = keyResult.data?.data.hotkey;
  const queriedAt = keyResult.data?.data.queried_at;

  return (
    <Panel as="div" dense className="mb-6">
      <div className="mg-label">Current Sudo key</div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono mg-type-data text-ink-strong">
          {phase === "pending" ? (
            <span className="text-ink-muted">…</span>
          ) : phase === "error" ? (
            <StatUnavailable />
          ) : hotkey ? (
            <AddressDisplay ss58={hotkey} fallback={<>{hotkey}</>} keep={8} linkToAccount={false} />
          ) : (
            <span title="Root key has been renounced on-chain">Unset</span>
          )}
        </span>
        {phase === "ready" && queriedAt ? (
          <span className="mg-type-caption text-ink-muted">
            queried <TimeAgo at={queriedAt} />
          </span>
        ) : phase === "ready" && !hotkey ? (
          <span className="mg-type-caption text-ink-muted">root key renounced</span>
        ) : null}
      </div>
    </Panel>
  );
}

export function SudoTable() {
  const search = useSearch({ from: "/chain/governance" });
  const navigate = useNavigate({ from: "/chain/governance" });
  const queryParams = sudoQueryParams(search);

  const setSearch = (patch: Record<string, unknown>) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }) as never,
      // Patch in-page search/filter state only; do not scroll to top on each keystroke (#3691).
      resetScroll: false,
    });

  return (
    <CallModuleExtrinsicsTable
      queryOptions={sudoCallsQuery(queryParams)}
      search={{
        limit: search.limit,
        offset: search.offset,
        call_function: search.call_function,
        success: search.success,
      }}
      setSearch={setSearch}
      emptyTitle="No Sudo calls indexed yet"
      emptyDescription="Root-origin calls are rare (zero in a typical two-week window) — check back later, or open the API directly."
      emptyApiPath={`${API_BASE}/api/v1/sudo`}
    />
  );
}
