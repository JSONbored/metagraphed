import { useMemo, useState } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import {
  AnalyticsPage,
  AnalyticsSection,
  DataTable,
  EntityHero,
  Fact,
  FactSentence,
  LeaderCards,
  RangeControl,
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
  activeRows,
  holderCards,
  plural,
  shortAddress,
  type ActiveRow,
  type HolderMetric,
} from "@/components/metagraphed/accounts-index/accounts-index-logic";
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import { accountHolderDirectoryQuery, chainSignersQuery } from "@/lib/metagraphed/queries";
import { formatNumber } from "@/lib/metagraphed/format";
import { API_BASE } from "@/lib/metagraphed/config";
import { Route } from "./accounts.index";

const SECTIONS = [
  { id: "holders", name: "Registered hotkeys" },
  { id: "active", name: "Active" },
] as const;

const API_PATHS = ["/api/v1/accounts/directory", "/api/v1/chain/signers"];

function ApiSources() {
  useRegisterApiSource(API_PATHS);
  return null;
}

export function AccountsPage() {
  const { h160 } = Route.useSearch();
  const [metric, setMetric] = useState<HolderMetric>("reach");
  const [signerQuery, setSignerQuery] = useState("");
  const { ref: activeRef, nearViewport: activeNearViewport } = useNearViewport("0px 0px");

  const directory = useSuspenseQuery(accountHolderDirectoryQuery());
  const signers = useQuery({
    ...chainSignersQuery("7d"),
    // The registered-hotkey directory is this route's immediate answer. Keep the
    // separate signing-activity ledger anchored and explicit, but do not ask
    // it to compete with the first account ranking before a reader reaches it.
    enabled: activeNearViewport,
    retry: 0,
  });

  const accountCount = directory.data.data.account_count;
  const ranked = directory.data.data.rankings?.[metric] ?? [];
  // Read only the independent membership/emission ranking, including when an
  // older dehydrated result still carries numeric capital fields.
  const cards = holderCards(ranked, metric);
  const active = useMemo(() => activeRows(signers.data?.data.signers ?? []), [signers.data]);
  const shownActive = useMemo(() => {
    const query = signerQuery.trim().toLowerCase();
    return query ? active.filter((row) => row.signer.toLowerCase().includes(query)) : active;
  }, [active, signerQuery]);

  // A fixed tuple, not a spread: FactNodes caps a sentence at six facts by
  // TYPE, and a conditional spread erases the length the cap is checked on.
  const sentence: FactNodes = h160
    ? [<Fact key="h160">{`looking up ${shortAddress(h160)}`}</Fact>]
    : [];

  const cells: FactCells = [{ label: "Registered hotkeys", value: formatNumber(accountCount) }];

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
                <FactSentence>Registered hotkeys and signing activity. {sentence}</FactSentence>
                <AccountLookup />
              </>
            }
            cells={cells}
            live={{
              updatedAt: directory.data.data.captured_at ?? null,
              source: "chain-direct index",
              onRefresh: () => void directory.refetch(),
            }}
          />
        }
      >
        <AnalyticsSection
          id="holders"
          name="Registered hotkeys"
          question="Hotkeys by subnet reach or emission."
          controls={
            <RangeControl
              label="Rank by"
              options={HOLDER_METRICS}
              value={metric}
              onChange={(next) => setMetric(next as HolderMetric)}
            />
          }
          visual={
            cards.length > 0 ? (
              <LeaderCards
                items={cards.map((card) => ({ ...card, initials: card.name.slice(0, 2) }))}
                featured={3}
                ariaLabel={`Registered hotkeys ranked by ${metric}`}
                source="account-holder"
              />
            ) : (
              <p className="text-13 text-ink-muted">
                No registered-hotkey rows are available in this ranking.
              </p>
            )
          }
          footnote={`${plural(cards.length, "hotkey")} shown from the bounded ${metric} ranking · capital values and ownership shares are unavailable: neuron voting weight does not establish wallet holdings · chain-direct index`}
        />
        <AnalyticsSection
          id="active"
          name="Active"
          question="The accounts signing the most transactions."
          visualRef={activeRef}
          visual={
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
              loading={!activeNearViewport || signers.isPending}
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
          }
          footnote={
            !activeNearViewport
              ? "7d signing activity · chain-direct"
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
