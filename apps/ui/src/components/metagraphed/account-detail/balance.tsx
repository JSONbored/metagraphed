import { useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { RawRow } from "@jsonbored/ui-kit";
import { createV2ReadClient } from "../../../../../../src/v2/client.ts";
import { ss58AccountId } from "@/lib/metagraphed/accounts";
import { formatAbsoluteTime, joinAmountUnit } from "@/lib/metagraphed/format";
import { asRao, raoToTao } from "@/lib/metagraphed/units";
import {
  modernBalanceKey,
  modernBalancePath,
  readModernAccountBalance,
  useModernExplorerConfiguration,
  type ModernAccountBalance,
} from "@/lib/metagraphed/modern-explorer";

export type AccountBalanceView = {
  value: string;
  loading: boolean;
  notice: string;
  rows: RawRow[];
  source?: { origin: string; paths: string[] };
};

/** An exact snapshot subtotal; frozen overlaps free and is never added or subtracted. */
export function accountBalanceView(
  data: ModernAccountBalance | undefined,
  loading = false,
  failed = false,
): AccountBalanceView {
  if (!data)
    return {
      value: "—",
      loading,
      notice: failed ? "Balance is unavailable." : "",
      rows: [{ label: "Balance status", value: loading ? "loading" : "unavailable" }],
    };
  const info = data.result.status === "stored" ? data.result.account : data.result.runtime_default;
  const observation = `block ${data.balance.state.block_number} (${formatAbsoluteTime(data.balance.observed_at)})`;
  return {
    value:
      !failed && data.result.status === "stored"
        ? joinAmountUnit(raoToTao(asRao(BigInt(info.free_rao) + BigInt(info.reserved_rao))), "τ")
        : "—",
    loading,
    notice: failed
      ? `Balance refresh failed; the retained observation from ${observation} is available in Raw.`
      : data.result.status === "not_stored"
        ? `No account entry is stored at ${observation}; Raw shows its runtime default.`
        : `Balance observed at ${observation}; freshness at response: ${data.freshness.status}.`,
    rows: [
      {
        label: "Balance status",
        value: failed ? `refresh failed; retained ${data.result.status}` : data.result.status,
      },
      { label: "Balance free (rao)", value: info.free_rao },
      { label: "Balance reserved (rao)", value: info.reserved_rao },
      { label: "Balance frozen (rao, overlapping constraint)", value: info.frozen_rao },
      { label: "Balance nonce", value: info.nonce },
      { label: "Balance flags", value: info.flags },
      { label: "Balance state block", value: data.balance.state.block_number },
      { label: "Balance state hash", value: data.balance.state.block_hash },
      { label: "Balance observed at", value: data.balance.observed_at },
      { label: "Balance observation", value: data.balance.observation_id },
      { label: "Balance publication", value: data.balance.publication_id },
      { label: "Balance storage profile", value: data.balance.profile_revision },
      { label: "Balance qualification", value: data.balance.qualification },
      { label: "Balance freshness at response", value: data.freshness.status },
    ],
  };
}

/** Switch only the balance observer so network selection preserves the page and its settings. */
export function AccountBalance({
  ss58,
  children,
}: {
  ss58: string;
  children: (view: AccountBalanceView) => ReactNode;
}) {
  const configuration = useModernExplorerConfiguration();
  const accountId = ss58AccountId(ss58);
  const scope = configuration?.status === "ready" && accountId ? configuration.scope : null;
  const origin = scope?.origin ?? null;
  const reader = useMemo(() => (origin ? createV2ReadClient({ origin }) : null), [origin]);
  const query = useQuery({
    queryKey:
      scope && accountId
        ? modernBalanceKey(scope, accountId)
        : [
            "metagraphed",
            "v2",
            "unconfigured-account-balance",
            configuration?.status ?? "pending",
            ss58,
          ],
    enabled: scope !== null && accountId !== null,
    queryFn: ({ signal }) => {
      if (!reader || !scope || !accountId)
        throw new Error("Account balance selection is unavailable");
      return readModernAccountBalance(reader, scope, accountId, signal);
    },
    gcTime: 0,
    staleTime: 30_000,
    retry: false,
    retryOnMount: false,
    refetchOnWindowFocus: false,
  });
  if (scope && accountId)
    return children({
      ...accountBalanceView(query.data, query.isPending, query.isError),
      source: { origin: scope.origin, paths: [modernBalancePath(scope, accountId)] },
    });
  const pending = configuration === null && accountId !== null;
  const view = accountBalanceView(undefined, pending);
  view.notice =
    accountId === null
      ? "This account address is invalid; no balance was queried."
      : configuration?.status === "unsupported-network"
        ? "Balance is unavailable for the selected network; no other network was queried."
        : pending
          ? ""
          : "Balance is unavailable from the selected API source.";
  return children(view);
}
