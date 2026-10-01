import { useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnalyticsSection, DataTable, Raw, type DataTableColumn } from "@jsonbored/ui-kit";
import { useNearViewport } from "@/hooks/use-near-viewport";
import { useNetwork } from "@/hooks/use-api-base";
import { DEFAULT_API_BASE, getApiBase, onApiBaseChange } from "@/lib/metagraphed/config";
import {
  accountRootBasketsQuery,
  rootBasketsQuery,
  basketTao,
  basketIndex,
  basketReadState,
  type BasketPricing,
  type BasketEntry,
} from "@/lib/metagraphed/root-baskets";

export function RootBasketsSection({
  selected,
  onSelect,
}: {
  selected: string;
  onSelect: (hotkey: string) => void;
}) {
  const { network } = useNetwork();
  const base = useSyncExternalStore(onApiBaseChange, getApiBase, () => DEFAULT_API_BASE);
  return <RootBasketsView key={`${base}:${network.id}`} selected={selected} onSelect={onSelect} />;
}

function RootBasketsView({
  selected,
  onSelect,
}: {
  selected: string;
  onSelect: (hotkey: string) => void;
}) {
  const queryClient = useQueryClient();
  const { ref, nearViewport } = useNearViewport("0px 0px");
  const [page, setPage] = useState<{ cursor?: string; as_of?: string }>({});
  const query = useQuery({ ...rootBasketsQuery(page), enabled: nearViewport || Boolean(selected) });
  const result = query.data?.data;
  const directory =
    result?.status === "available" && result.data.kind === "directory" ? result.data : null;
  const hash = result?.status === "available" ? result.source.finalized_block_hash : undefined;
  const detail = useQuery({
    ...rootBasketsQuery({ hotkey: selected, as_of: hash }),
    enabled: Boolean(selected) && hash !== undefined,
  });
  const fundResult = detail.data?.data;
  const fund =
    fundResult?.status === "available" && fundResult.data.kind === "fund" ? fundResult.data : null;
  const columns: DataTableColumn<BasketPricing>[] = [
    {
      key: "hotkey",
      label: "Fund hotkey",
      kind: "identifier",
      value: (row) => row.hotkey,
      render: (row) => (
        <button
          type="button"
          className="mg-section-more"
          onClick={() => onSelect(row.hotkey)}
          aria-label={`Inspect basket ${row.hotkey}`}
        >
          {row.hotkey.slice(0, 10)}…{row.hotkey.slice(-6)}
        </button>
      ),
    },
    { key: "nav", label: "Spot NAV", value: (row) => basketTao(row.spot_nav_rao) },
    {
      key: "price",
      label: "Display price (TAO/β, 4 d.p.)",
      value: (row) => basketIndex(row.display_price_q64_bits),
    },
    {
      key: "provisional",
      label: "Baseline",
      value: (row) => (row.provisional ? "Provisional" : `Since block ${row.first_block}`),
    },
  ];
  const state = basketReadState(result, query.isError);
  return (
    <AnalyticsSection
      id="baskets"
      name="Root baskets"
      question="Inspect native holdings and the value of outstanding β."
      visualRef={ref}
      footnote={
        result?.status === "available"
          ? `${result.network} · finalized block ${result.source.finalized_block} · one page, storage order`
          : "Current state · no historical return window"
      }
      visual={
        <div>
          {state ? (
            <p className="text-13 text-ink-muted">{state}</p>
          ) : (
            <DataTable
              caption="Native Root baskets"
              rows={directory?.pricing ?? []}
              columns={columns}
              rowKey={(row) => row.hotkey}
              paginate={false}
              source="root-baskets"
              empty="No active funds on this page."
            />
          )}
          <div className="flex flex-wrap gap-4">
            {query.isError || result?.status === "unavailable" ? (
              <button
                type="button"
                className="mg-section-more"
                onClick={() => void query.refetch()}
              >
                Retry baskets
              </button>
            ) : null}
            {directory?.next_after && hash ? (
              <button
                type="button"
                className="mg-section-more"
                onClick={() => setPage({ cursor: directory.next_after!, as_of: hash })}
              >
                Next basket page
              </button>
            ) : null}
            {page.cursor ? (
              <button
                type="button"
                className="mg-section-more"
                onClick={() => {
                  setPage({});
                  void queryClient.invalidateQueries({
                    queryKey: rootBasketsQuery().queryKey,
                    exact: true,
                  });
                }}
              >
                Latest first page
              </button>
            ) : null}
          </div>
          {selected ? (
            <div>
              <h3 className="mt-6 text-13 font-semibold">Selected fund</h3>
              {fund ? (
                <>
                  <Raw
                    title="Fund values and trading gates"
                    rows={[
                      { label: "hotkey", value: fund.summary.hotkey },
                      { label: "spot NAV", value: basketTao(fund.summary.spot_nav_rao) },
                      {
                        label: "realizable NAV",
                        value: basketTao(fund.summary.realizable_nav_rao),
                      },
                      {
                        label: "trading",
                        value:
                          fund.trading.enabled && !fund.trading.frozen
                            ? "Enabled"
                            : "Disabled or frozen",
                      },
                      { label: "turnover available", value: basketTao(fund.trading.available_rao) },
                      { label: "turnover budget", value: basketTao(fund.trading.budget_rao) },
                      {
                        label: "baseline",
                        value: fund.baseline.provisional
                          ? "Provisional"
                          : `Block ${fund.baseline.first_block}`,
                      },
                      {
                        label: "display price Q64 bits",
                        value: fund.pricing?.display_price_q64_bits ?? "No outstanding shares",
                      },
                      {
                        label: "staker TWR Q64 bits",
                        value: fund.pricing?.staker_twr_q64_bits ?? "Unavailable",
                      },
                    ]}
                  />
                  <DataTable
                    caption="Fund holdings"
                    rows={fund.summary.holdings}
                    rowKey={(row) => String(row.netuid)}
                    paginate={false}
                    source="root-basket-holdings"
                    columns={[
                      {
                        key: "netuid",
                        label: "Subnet",
                        value: (row) => (row.netuid === 0 ? "Root cash" : `SN${row.netuid}`),
                      },
                      {
                        key: "quantity",
                        label: "Exact quantity",
                        value: (row) => `${row.quantity_atomic} ${row.quantity_unit}`,
                      },
                      {
                        key: "spot",
                        label: "Spot value",
                        value: (row) => basketTao(row.spot_value_rao),
                      },
                      {
                        key: "realizable",
                        label: "Realizable value",
                        value: (row) => basketTao(row.realizable_value_rao),
                      },
                    ]}
                  />
                </>
              ) : (
                <p className="text-13 text-ink-muted">
                  {hash === undefined ? state : basketReadState(fundResult, detail.isError)}
                </p>
              )}
              {detail.isError || fundResult?.status === "unavailable" ? (
                <button
                  type="button"
                  className="mg-section-more"
                  onClick={() => void detail.refetch()}
                >
                  Retry fund
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      }
    />
  );
}

export function AccountRootBasketsSection({ ss58 }: { ss58: string }) {
  const { network } = useNetwork();
  const base = useSyncExternalStore(onApiBaseChange, getApiBase, () => DEFAULT_API_BASE);
  return <AccountRootBasketsView key={`${base}:${network.id}:${ss58}`} ss58={ss58} />;
}

function AccountRootBasketsView({ ss58 }: { ss58: string }) {
  const queryClient = useQueryClient();
  const { ref, nearViewport } = useNearViewport("0px 0px");
  const [page, setPage] = useState<{ offset?: number; as_of?: string }>({});
  const query = useQuery({ ...accountRootBasketsQuery(ss58, page), enabled: nearViewport });
  const result = query.data?.data;
  const account =
    result?.status === "available" && result.data.kind === "account" ? result.data : null;
  const positions =
    account?.entries.filter((entry) => entry.position !== null || entry.claim !== null) ?? [];
  const columns: DataTableColumn<BasketEntry>[] = [
    {
      key: "hotkey",
      label: "Fund hotkey",
      kind: "link",
      value: (row) => row.hotkey,
      href: (row) => `/validators?basket=${encodeURIComponent(row.hotkey)}#baskets`,
    },
    { key: "beta", label: "Exact β atoms", value: (row) => row.position?.beta_atomic ?? "—" },
    { key: "spot", label: "Spot value", value: (row) => basketTao(row.position?.spot_value_rao) },
    {
      key: "realizable",
      label: "Realizable value",
      value: (row) => basketTao(row.position?.realizable_value_rao),
    },
    { key: "claim", label: "Claim estimate", value: (row) => basketTao(row.claim?.redeemable_rao) },
    { key: "dust", label: "Skipped dust rows", value: (row) => row.claim?.dust_rows ?? null },
  ];
  const state = basketReadState(result, query.isError);
  return (
    <AnalyticsSection
      id="root-baskets"
      name="Native Root positions"
      question="Basket β and claim estimates, separate from free TAO and root principal."
      visualRef={ref}
      footnote={
        result?.status === "available" && account
          ? `${result.network} · finalized block ${result.source.finalized_block} · relationships ${account.offset}–${account.offset + account.entries.length} of ${account.total_relationships}`
          : "Watch-only · no wallet connection or signing"
      }
      visual={
        <div>
          {state ? (
            <p className="text-13 text-ink-muted">{state}</p>
          ) : (
            <DataTable
              caption="Native basket positions"
              rows={positions}
              columns={columns}
              rowKey={(row) => row.hotkey}
              paginate={false}
              source="account-root-baskets"
              empty={
                account?.next_offset !== null
                  ? "No basket entitlement in this relationship page. Continue to check the next page."
                  : "No basket entitlement in these relationships."
              }
            />
          )}
          <div className="flex flex-wrap gap-4">
            {query.isError || result?.status === "unavailable" ? (
              <button
                type="button"
                className="mg-section-more"
                onClick={() => void query.refetch()}
              >
                Retry native positions
              </button>
            ) : null}
            {account?.next_offset != null && result?.status === "available" ? (
              <button
                type="button"
                className="mg-section-more"
                onClick={() =>
                  setPage({
                    offset: account.next_offset!,
                    as_of: result.source.finalized_block_hash,
                  })
                }
              >
                Next relationship page
              </button>
            ) : null}
            {page.offset ? (
              <button
                type="button"
                className="mg-section-more"
                onClick={() => {
                  setPage({});
                  void queryClient.invalidateQueries({
                    queryKey: accountRootBasketsQuery(ss58).queryKey,
                    exact: true,
                  });
                }}
              >
                Latest first page
              </button>
            ) : null}
          </div>
        </div>
      }
    />
  );
}
