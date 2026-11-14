import { useMemo, useState } from "react";
import { useInfiniteQuery, type InfiniteData } from "@tanstack/react-query";
import { AnalyticsSection, DataTable, Raw, RawCode, type DataTableColumn } from "@jsonbored/ui-kit";
import { createV2ReadClient } from "../../../../../../src/v2/client.ts";
import { ErrorState } from "@/components/metagraphed/states";
import { useNearViewport } from "@/hooks/use-near-viewport";
import { ss58AccountId } from "@/lib/metagraphed/accounts";
import { formatAbsoluteTime } from "@/lib/metagraphed/format";
import {
  MODERN_ACCOUNT_MAX_PAGES,
  modernStakeAnchor,
  modernStakeKey,
  modernStakePath,
  ModernExplorerSources,
  readModernAccountStake,
  useModernExplorerConfiguration,
  type ModernAccountStake,
  type ModernStakeContinuation,
  type ModernExplorerScope,
} from "@/lib/metagraphed/modern-explorer";

type Entry = ModernAccountStake["entries"][number];
const actionClass =
  "inline-flex min-h-11 items-center justify-center rounded border border-border px-3 py-2 text-13 text-ink-strong disabled:opacity-60";
const hotkey = (entry: Entry) =>
  entry.kind === "position" ? entry.position.hotkey : entry.entitlement.key.hotkey;
const columns: DataTableColumn<Entry>[] = [
  {
    key: "kind",
    label: "Record",
    value: (entry) => (entry.kind === "position" ? "Stake position" : "Root entitlement"),
  },
  { key: "hotkey", label: "Hotkey", kind: "identifier", value: hotkey },
  {
    key: "asset",
    wrap: true,
    label: "Asset / generation",
    value: (entry) => {
      if (entry.kind === "root_entitlement")
        return "Root claimant · deferred assets retain their own fund generations";
      const p = entry.position;
      const asset = p.asset.kind === "tao" ? "Root TAO" : `SN${p.netuid} alpha`;
      return p.subnet.status === "residual_storage"
        ? `${asset} · residual storage; generation unavailable`
        : `${asset} · generation ${p.subnet.generation.registration_counter} · ${p.subnet.lifecycle}`;
    },
  },
  {
    key: "quantity",
    sortable: false,
    wrap: true,
    label: "Exact quantity / state",
    value: (entry) => {
      if (entry.kind === "position") {
        const p = entry.position;
        return p.quote.status === "exact"
          ? `${p.quote.atomic_units} ${p.asset.unit} · ${p.assessment.share_state}`
          : `No current position · ${p.quote.state}`;
      }
      const { outcome, principal } = entry.entitlement;
      if (outcome.status === "protocol_custody") return "Protocol custody";
      const principalLabel =
        principal.status === "exact_rao"
          ? `Root principal ${principal.value} rao`
          : principal.status === "absent_in_complete_join"
            ? "No root principal entry in the complete census"
            : `No current root principal · ${principal.value}`;
      return `${principalLabel} · ${outcome.value.deferred_cash_rao} rao deferred cash · ${outcome.value.deferred_alpha.length} deferred alpha assets`;
    },
  },
  {
    key: "details",
    label: "Details",
    value: () => "Exact observations and entitlement fields",
    render: (entry) => (
      <Raw
        title={`${entry.kind === "position" ? "Position" : "Root entitlement"} ${hotkey(entry)}`}
      >
        <RawCode label="Exact stake record">{JSON.stringify(entry, null, 2)}</RawCode>
      </Raw>
    ),
  },
];

/** Existing account section, now reading the published stake census directly. */
export function PositionsSection({ ss58 }: { ss58: string }) {
  const configuration = useModernExplorerConfiguration();
  const accountId = ss58AccountId(ss58);
  if (configuration?.status === "ready" && accountId)
    return (
      <PublishedPositions
        key={JSON.stringify([configuration.scope, accountId])}
        scope={configuration.scope}
        accountId={accountId}
      />
    );
  const pending = accountId !== null && configuration === null;
  return (
    <AnalyticsSection
      id="positions"
      name="Positions"
      question="Published stake positions and independent root entitlements."
      visual={
        pending ? (
          <DataTable
            rows={[]}
            columns={columns}
            rowKey={() => "pending"}
            caption="Account stake and entitlements"
            loading
            paginate={false}
            mobile="cards"
          />
        ) : (
          <p role="status">
            {accountId === null
              ? "This address has an invalid checksum or an unsupported account format. No account stake was queried."
              : configuration?.status === "unsupported-network"
                ? "Published account stake is unavailable for the selected network. No other network was queried."
                : "The selected API source must be a public HTTPS origin or a local development origin."}
          </p>
        )
      }
      footnote={
        pending ? "Choose your network and API source to load published account stake." : undefined
      }
    />
  );
}

function PublishedPositions({
  scope,
  accountId,
}: {
  scope: ModernExplorerScope;
  accountId: string;
}) {
  const { ref, nearViewport } = useNearViewport("320px 0px");
  const [restart, setRestart] = useState(0);
  const reader = useMemo(() => createV2ReadClient({ origin: scope.origin }), [scope.origin]);
  const feed = useInfiniteQuery<
    ModernAccountStake,
    Error,
    InfiniteData<ModernAccountStake, ModernStakeContinuation | null>,
    ReturnType<typeof modernStakeKey>,
    ModernStakeContinuation | null
  >({
    queryKey: modernStakeKey(scope, accountId, restart),
    initialPageParam: null,
    queryFn: ({ pageParam, signal }) =>
      readModernAccountStake(reader, scope, accountId, pageParam ?? undefined, signal),
    getNextPageParam: (last) =>
      last.next_cursor === null
        ? undefined
        : { anchor: modernStakeAnchor(last), cursor: last.next_cursor },
    maxPages: MODERN_ACCOUNT_MAX_PAGES,
    gcTime: 0,
    enabled: nearViewport,
    retry: false,
    retryOnMount: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const pages = feed.data?.pages ?? [];
  const first = pages[0];
  const entries = pages.flatMap((page) => page.entries);
  const params = feed.data?.pageParams ?? [null];
  const paths = params.map((page) => modernStakePath(scope, accountId, page?.cursor));
  const unavailable = new Error(
    "Published account stake is unavailable. Retry or restart from the latest census.",
  );
  const positions = entries.filter((entry) => entry.kind === "position").length;
  const claimants = entries.length - positions;
  return (
    <>
      <ModernExplorerSources paths={paths} origin={scope.origin} />
      <AnalyticsSection
        id="positions"
        name="Positions"
        question="Published stake positions and independent root entitlements."
        visualRef={ref}
        controls={
          <button
            type="button"
            className={actionClass}
            onClick={() => setRestart((value) => value + 1)}
          >
            Restart from latest census
          </button>
        }
        visual={
          <>
            <DataTable
              rows={entries}
              columns={columns}
              rowKey={(entry) =>
                `${entry.kind}:${hotkey(entry)}:${entry.kind === "position" ? entry.position.netuid : "root"}`
              }
              caption="Account stake and entitlements"
              source="published-account-stake"
              paginate={false}
              loading={!nearViewport || feed.isPending}
              mobile="cards"
              dense
              error={
                feed.isError && entries.length === 0 ? (
                  <ErrorState
                    error={unavailable}
                    context="account stake"
                    onRetry={() => void feed.refetch()}
                  />
                ) : undefined
              }
              empty={
                first
                  ? "No stake positions or root entitlements for this coldkey in the published complete census."
                  : "Account stake coverage has not been established."
              }
            />
            {feed.isError && entries.length > 0 ? (
              <>
                <p role="status">
                  Previously accepted stake records retained. Restart to select a new census.
                </p>
                <ErrorState
                  error={unavailable}
                  context="more stake records"
                  onRetry={() => void feed.fetchNextPage()}
                />
              </>
            ) : null}
            {feed.hasNextPage ? (
              <button
                type="button"
                className={`mt-3 ${actionClass}`}
                disabled={feed.isFetchingNextPage}
                onClick={() => void feed.fetchNextPage()}
              >
                {feed.isFetchingNextPage
                  ? "Loading more stake records…"
                  : "Load more stake records"}
              </button>
            ) : null}
          </>
        }
        footnote={
          first ? (
            <>
              Loaded {positions} position records and {claimants} root entitlement records. Census
              at block {first.stake.state.block_number}, observed{" "}
              {formatAbsoluteTime(first.stake.observed_at)} · freshness {first.freshness.status}.{" "}
              Amounts retain their stated units. Root principal and entitlement records are separate
              and must not be added together. Liquid balances and combined TAO valuation are not
              supplied by this census. Qualification: {first.stake.qualification}; state proof and
              runtime semantics are unverified. Up to {MODERN_ACCOUNT_MAX_PAGES} loaded pages are
              retained in this view; other account sections have separate observations.
            </>
          ) : !nearViewport ? (
            "Account stake loads when this section is near the viewport."
          ) : feed.isPending ? (
            "Loading published account stake."
          ) : (
            "Account stake coverage is unavailable."
          )
        }
      />
    </>
  );
}
