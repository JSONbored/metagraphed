import { useMemo, useState } from "react";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { metagraphedQueryInvalidationTarget } from "@/hooks/use-api-base";
import {
  AnalyticsPage,
  AnalyticsSection,
  DataTable,
  EntityHero,
  Fact,
  FactSentence,
  LeaderCards,
  RangeControl,
  RESIDUAL_KEY,
  Raw,
  type DataTableColumn,
  type FactCells,
  type FactNodes,
  type RawRow,
} from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { RouterLink } from "@/components/metagraphed/router-link";
import { ErrorState } from "@/components/metagraphed/states";
import { AccountLookup } from "@/components/metagraphed/accounts-index/lookup";
import { useNearViewport } from "@/hooks/use-near-viewport";
import {
  HOLDER_METRICS,
  HOLDER_SORT,
  activeRows,
  concentrationSegments,
  fmtTaoCompact,
  holderCards,
  shortAddress,
  type ActiveRow,
  type HolderMetric,
} from "@/components/metagraphed/accounts-index/accounts-index-logic";
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import { accountsListQuery, chainSignersQuery } from "@/lib/metagraphed/queries";
import { formatNumber, formatPct } from "@/lib/metagraphed/format";
import { API_BASE } from "@/lib/metagraphed/config";
import { Route } from "./accounts.index";

const SECTIONS = [
  { id: "holders", name: "Holders" },
  { id: "active", name: "Active" },
] as const;

const API_PATHS = ["/api/v1/accounts", "/api/v1/chain/signers"];

const LISTED = 20;

function ApiSources() {
  useRegisterApiSource(API_PATHS);
  return null;
}

export function AccountsPage() {
  const { h160 } = Route.useSearch();
  const queryClient = useQueryClient();
  const [metric, setMetric] = useState<HolderMetric>("stake");
  const [signerQuery, setSignerQuery] = useState("");
  const { ref: activeRef, nearViewport: activeNearViewport } = useNearViewport("0px 0px");

  const { data: byStake } = useSuspenseQuery(
    accountsListQuery({ sort: HOLDER_SORT.stake, limit: LISTED }),
  );
  const ranked = useQuery({
    ...accountsListQuery({ sort: HOLDER_SORT[metric], limit: LISTED }),
    retry: 0,
  });
  const signers = useQuery({
    ...chainSignersQuery("7d"),
    // The holders directory is this route's immediate answer. Keep the
    // separate signing-activity ledger anchored and explicit, but do not ask
    // it to compete with the first account ranking before a reader reaches it.
    enabled: activeNearViewport,
    retry: 0,
  });

  const accounts = byStake.data.accounts;
  const { segments, listedTotal } = useMemo(() => concentrationSegments(accounts, 10), [accounts]);
  const cards = holderCards(ranked.data?.data.accounts ?? [], metric, 18, listedTotal);
  const active = useMemo(() => activeRows(signers.data?.data.signers ?? []), [signers.data]);
  const shownActive = useMemo(() => {
    const query = signerQuery.trim().toLowerCase();
    return query ? active.filter((row) => row.signer.toLowerCase().includes(query)) : active;
  }, [active, signerQuery]);

  const topTen = segments
    .filter((segment) => segment.key !== RESIDUAL_KEY)
    .reduce((acc, segment) => acc + segment.value, 0);
  const topShare = listedTotal > 0 ? topTen / listedTotal : null;

  // A fixed tuple, not a spread: FactNodes caps a sentence at six facts by
  // TYPE, and a conditional spread erases the length the cap is checked on.
  // Only what the strip does not already state (#11693): "top 10 hold 80.6% of
  // them" sat directly above "Top 10 share 80.6%", and the signer count above
  // "Signers 7d", so two of three chips were the cell beneath them reworded.
  const sentence: FactNodes = h160
    ? [
        <Fact key="listed">{`${formatNumber(accounts.length)} accounts listed by stake`}</Fact>,
        <Fact key="h160">{`looking up ${shortAddress(h160)}`}</Fact>,
      ]
    : [<Fact key="listed">{`${formatNumber(accounts.length)} accounts listed by stake`}</Fact>];

  const cells: FactCells = [
    { label: "Stake listed", value: fmtTaoCompact(listedTotal) },
    { label: "Top 10 share", value: topShare === null ? "—" : `${formatPct(topShare, 1)}` },
  ];

  const activeColumns: DataTableColumn<ActiveRow>[] = [
    { key: "signer", label: "Account", kind: "identifier", value: (row) => row.signer },
    {
      key: "tx_count",
      label: "Transactions 7d",
      kind: "number",
      sortable: true,
      value: (row) => row.tx_count,
      format: (value) => (typeof value === "number" ? formatNumber(value) : "—"),
    },
    {
      key: "last_tx_block",
      label: "Last block",
      kind: "link",
      value: (row) => (row.last_tx_block == null ? "—" : String(row.last_tx_block)),
      href: (row) => (row.last_tx_block == null ? undefined : `/blocks/${row.last_tx_block}`),
    },
  ];

  const rawRows: RawRow[] = API_PATHS.map((path) => ({
    label: path.replace("/api/v1/", ""),
    value: `${API_BASE}${path}`,
    href: `${API_BASE}${path}`,
  }));

  return (
    <AppShell>
      <ApiSources />
      <AnalyticsPage
        sections={SECTIONS}
        hero={
          <EntityHero
            className="mg-hero--directory"
            name="Accounts"
            sentence={
              <>
                <FactSentence>Who holds the stake, and who is spending it. {sentence}</FactSentence>
                <AccountLookup />
              </>
            }
            cells={cells}
            live={{
              updatedAt: byStake.meta?.generated_at ?? null,
              source: "chain-direct index",
              onRefresh: () =>
                void queryClient.invalidateQueries(metagraphedQueryInvalidationTarget()),
            }}
          />
        }
      >
        <AnalyticsSection
          id="holders"
          name="Holders"
          question="The accounts holding the most."
          controls={
            <RangeControl
              label="Rank by"
              options={HOLDER_METRICS}
              value={metric}
              onChange={(next) => setMetric(next as HolderMetric)}
            />
          }
          visual={
            ranked.isPending ? (
              <LeaderCards
                items={[]}
                featured={3}
                loading
                loadingItems={LISTED}
                ariaLabel={`Accounts ranked by ${metric}`}
                source="account-holder"
              />
            ) : ranked.isError ? (
              <ErrorState
                error={ranked.error}
                onRetry={() => void ranked.refetch()}
                context="account holder ranking"
              />
            ) : cards.length > 0 ? (
              <LeaderCards
                items={cards.map((card) => ({ ...card, initials: card.name.slice(0, 2) }))}
                featured={3}
                ariaLabel={`Accounts ranked by ${metric}`}
                source="account-holder"
              />
            ) : null
          }
          footnote={
            ranked.isPending
              ? `loading accounts ranked by ${metric}`
              : ranked.isError
                ? `the ${metric} account ranking could not be loaded`
                : `top ${formatNumber(LISTED)} by ${metric} · shares are of the ${fmtTaoCompact(
                    listedTotal,
                  )} these ${formatNumber(accounts.length)} hold, not of all stake · chain-direct index`
          }
        />
        <AnalyticsSection
          id="active"
          name="Active"
          question="The accounts signing the most transactions."
          visualRef={activeRef}
          visual={
            !activeNearViewport ? (
              <p className="mg-section-empty">Signing activity loads as this section approaches.</p>
            ) : (
              <DataTable
                rows={shownActive}
                columns={activeColumns}
                rowKey={(row) => row.signer}
                caption="Signing accounts"
                rowHref={(row) => `/accounts/${row.signer}`}
                link={RouterLink}
                source="account-signer"
                paginate={false}
                mobile="cards"
                loading={signers.isPending}
                error={
                  signers.isError ? (
                    <ErrorState
                      error={signers.error}
                      onRetry={() => void signers.refetch()}
                      context="recent signing activity"
                    />
                  ) : undefined
                }
                empty="No signing activity was indexed in this window."
                search={{
                  value: signerQuery,
                  onChange: setSignerQuery,
                  placeholder: "Find a signer",
                }}
                storageKey="accounts-signers-columns"
              />
            )
          }
          footnote={
            !activeNearViewport
              ? "deferred below the fold · signing activity loads as this section approaches"
              : signers.isPending
                ? "loading 7d signing activity"
                : signers.isError
                  ? "7d signing activity could not be loaded"
                  : `7d · ${formatNumber(shownActive.length)} of ${formatNumber(
                      active.length,
                    )} signers · chain-direct`
          }
        />
        <Raw rows={rawRows} title="Account index API" />
      </AnalyticsPage>
    </AppShell>
  );
}
