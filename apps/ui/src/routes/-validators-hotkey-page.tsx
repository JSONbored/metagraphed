import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useQueries, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { Coins, Percent, TriangleAlert } from "lucide-react";
import { useWallet } from "@/hooks/use-wallet";
import { AppShell } from "@/components/metagraphed/app-shell";
import { EmptyState, Skeleton, StaleBanner } from "@/components/metagraphed/states";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { EndpointSnippet } from "@/components/metagraphed/endpoint-snippet";
import { ShareButton, SectionAnchor, ActionBar, SegmentedToggle, Chip } from "@jsonbored/ui-kit";
import {
  CompositionBreakdown,
  MeasureBand,
  type Measure,
  AsyncPanel,
  DataPageCanvas,
  DataPageModule,
  DataPageStage,
  PageMasthead,
} from "@/components/metagraphed/primitives";
import { ProfileTabs, useActiveTab } from "@/components/metagraphed/profile-tabs";
import { WatchStarButton } from "@/components/metagraphed/watch-star-button";
import { ValidatorHistoryChart } from "@/components/metagraphed/validator-history-chart";
import { AddressDisplay } from "@/components/metagraphed/address-display";
import { WatchValidatorAlert } from "@/components/metagraphed/watch-validator-alert";
import { StakeUnstakeModal } from "@/components/metagraphed/stake-unstake-modal";
import { TakeManagementModal } from "@/components/metagraphed/take-management-modal";
import { SearchInput } from "@/components/metagraphed/table-controls";
import {
  ValidatorNominatorsTable,
  type ValidatorNominatorsSearch,
} from "@/components/metagraphed/validator-nominators-table";
import { taoCompact, scoreStr } from "@/components/metagraphed/neuron-format";
import {
  nametagIndexQuery,
  validatorDetailQuery,
  validatorHistoryQuery,
  validatorNominatorsQuery,
  metagraphedQueryKey,
} from "@/lib/metagraphed/queries";
import { isValidSs58, ss58PathSegment } from "@/lib/metagraphed/accounts";
import { resolveAddress } from "@/lib/metagraphed/resolve-address";
import { formatNumber, isStaleFreshness } from "@/lib/metagraphed/format";
import { matchesQuery } from "@/lib/metagraphed/url-state";
import { hasValidatorIdentity } from "@/lib/metagraphed/validator-identity";
import { isUnrecognizedValidator } from "@/lib/metagraphed/validator-recognition";
import {
  annualizedDelegatorApyPct,
  apyFromRewardsPer1000,
  formatApyPct,
  formatTakePct,
  type ValidatorApyWindow,
} from "@/lib/metagraphed/validator-apy";
import type { ValidatorDetailSubnet } from "@/lib/metagraphed/types";
import { subnetPositionDestination } from "@/lib/metagraphed/subnet-position-link";

// #8251: tabs replace the old single 11,000px+ stacked page — same ProfileTabs
// convention as subnets.$netuid.tsx.
const TABS = [
  { id: "subnets", label: "Per-subnet performance" },
  { id: "nominators", label: "Nominators" },
  { id: "history", label: "History" },
] as const;

// Per-subnet table shows the top N by stake until expanded — most validators
// with 100+ memberships have a long tail of dust rows.
const SUBNETS_INITIAL = 20;

export function ValidatorDetailPage() {
  const { hotkey } = useParams({ from: "/validators/$hotkey" });
  return (
    <AppShell>
      <AsyncPanel
        context="validator"
        fallback={<Skeleton className="h-96 w-full" />}
        retryQueryKeys={[validatorDetailQuery(hotkey).queryKey]}
      >
        <ValidatorDetail hotkey={hotkey} />
      </AsyncPanel>
    </AppShell>
  );
}

/** A per-subnet row's own stake/emission, in the token it is denominated in:
 * TAO on root, that subnet's alpha everywhere else (metagraphed#10514). The
 * card's `total_stake_tao` is the priced TAO figure; these are not. */
function subnetStakeStr(s: ValidatorDetailSubnet): string {
  return `${taoCompact(s.stake_alpha)} ${s.netuid === 0 ? "τ" : "α"}`;
}

function subnetEmissionStr(s: ValidatorDetailSubnet): string {
  return `${taoCompact(s.emission_alpha)} ${s.netuid === 0 ? "τ" : "α"}`;
}

function SubnetPerformanceTab({ subnets }: { subnets: ValidatorDetailSubnet[] }) {
  const [q, setQ] = useState("");
  const [showAll, setShowAll] = useState(false);
  const sorted = useMemo(
    () => [...subnets].sort((a, b) => (b.stake_alpha ?? 0) - (a.stake_alpha ?? 0)),
    [subnets],
  );
  const filtered = useMemo(
    () => sorted.filter((s) => matchesQuery([s.netuid, `SN${s.netuid}`, s.uid], q)),
    [sorted, q],
  );
  const visible = showAll || q ? filtered : filtered.slice(0, SUBNETS_INITIAL);

  if (subnets.length === 0) {
    return (
      <EmptyState
        title="No active subnet memberships"
        description="This hotkey isn't currently registered as a validator on any subnet."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          value={q}
          onChange={setQ}
          placeholder="Filter by netuid"
          className="w-full sm:w-64"
        />
        <span className="mg-type-data text-ink-muted">
          {formatNumber(filtered.length)} membership{filtered.length === 1 ? "" : "s"}
        </span>
      </div>

      {/* Desktop table. #8251: the per-row Stake buttons died — the page's ONE
          Delegate CTA lives in the header. */}
      <div className="hidden md:block overflow-x-auto rounded-md border border-border">
        <table className="w-full text-left text-sm">
          <thead className="bg-surface/50">
            <tr>
              <th className={TH}>Subnet</th>
              <th className={`${TH} text-right`}>UID</th>
              <th className={`${TH} text-right`}>Stake τ</th>
              <th className={`${TH} text-right`}>Emission τ</th>
              <th className={`${TH} text-right`}>Dividends</th>
              <th className={`${TH} text-right`}>Val trust</th>
              <th className={`${TH} text-center`}>Permit</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {visible.map((s) => (
              <tr key={s.netuid} className="hover:bg-surface/40">
                <td className="px-3 py-2 mg-type-data">
                  <SubnetCellLink s={s} />
                </td>
                <td className="px-3 py-2 text-right font-mono mg-type-caption tabular-nums text-ink-muted">
                  {s.uid}
                </td>
                <td className="px-3 py-2 text-right font-mono mg-type-caption tabular-nums text-ink-strong">
                  {subnetStakeStr(s)}
                </td>
                <td className="px-3 py-2 text-right font-mono mg-type-caption tabular-nums text-ink">
                  {subnetEmissionStr(s)}
                </td>
                <td className="px-3 py-2 text-right font-mono mg-type-caption tabular-nums text-ink">
                  {scoreStr(s.dividends)}
                </td>
                <td className="px-3 py-2 text-right font-mono mg-type-caption tabular-nums text-ink-muted">
                  {scoreStr(s.validator_trust)}
                </td>
                <td className="px-3 py-2 text-center">
                  {s.validator_permit ? (
                    <span className="inline-flex items-center rounded border border-accent/40 bg-accent-surface px-1.5 py-0.5 mg-type-caption text-accent-text">
                      Yes
                    </span>
                  ) : (
                    <span className="mg-type-data-sm text-ink-subtle-text">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile: Subnet · Stake · Dividends rows with the long tail behind an
          expandable per-row detail — the 8-column table doesn't survive 390px. */}
      <ul className="space-y-2 md:hidden">
        {visible.map((s) => (
          <li key={s.netuid} className="rounded-md border border-border bg-card">
            <details>
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 [&::-webkit-details-marker]:hidden">
                <SubnetCellLink s={s} />
                <span className="flex items-center gap-4 mg-type-data tabular-nums">
                  <span className="text-ink-strong">{subnetStakeStr(s)}</span>
                  <span className="text-ink-muted">{scoreStr(s.dividends)}</span>
                </span>
              </summary>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-border px-3 py-2.5 mg-type-data">
                <MobileField label="UID" value={String(s.uid)} />
                <MobileField label="Emission" value={subnetEmissionStr(s)} />
                <MobileField label="Val trust" value={scoreStr(s.validator_trust)} />
                <MobileField label="Permit" value={s.validator_permit ? "Yes" : "—"} />
              </dl>
            </details>
          </li>
        ))}
      </ul>

      {!showAll && !q && filtered.length > SUBNETS_INITIAL ? (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="block w-full rounded border border-border bg-card px-3 py-2 mg-type-caption font-medium text-ink-muted hover:border-ink/30 hover:text-ink-strong min-h-9"
        >
          Show all {formatNumber(filtered.length)} memberships
        </button>
      ) : null}
    </div>
  );
}

function SubnetCellLink({ s }: { s: ValidatorDetailSubnet }) {
  const destination = subnetPositionDestination(s.uid);
  return (
    <Link
      to="/subnets/$netuid"
      params={{ netuid: s.netuid }}
      // Deep-link straight to this row's neuron card rather than the subnet
      // overview. The hash carries the focus target as well as the record
      // state, so keyboard and mobile visitors land on the selected neuron.
      search={destination?.search}
      hash={destination?.hash}
      className="text-ink-strong hover:text-accent hover:underline"
    >
      SN{s.netuid}
    </Link>
  );
}

function MobileField({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-ink-muted">{label}</dt>
      <dd className="text-right tabular-nums text-ink">{value}</dd>
    </>
  );
}

const TH = "mg-type-caption px-3 py-2 text-ink-muted";

function nominatorsQueryParams(search: ValidatorNominatorsSearch): Record<string, string | number> {
  const params: Record<string, string | number> = {
    window: search.window,
    sort: search.sort,
    limit: search.limit,
    offset: search.offset,
  };
  // Only a complete, valid ss58 is worth sending — the backend 400s on a partial
  // match, and a partial/invalid value updates on every keystroke, so gating here
  // keeps a mid-typing coldkey from ever reaching the API.
  if (search.coldkey && isValidSs58(search.coldkey)) params.coldkey = search.coldkey;
  return params;
}

function NominatorsSection({ hotkey }: { hotkey: string }) {
  const search = useSearch({ from: "/validators/$hotkey" });
  const navigate = useNavigate({ from: "/validators/$hotkey" });

  const setSearch = (patch: Partial<ValidatorNominatorsSearch>) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
      // Patch in-page search/filter state only; do not scroll to top on each keystroke (#3691).
      resetScroll: false,
    });

  const normalizedSearch: ValidatorNominatorsSearch = {
    window: search.window,
    sort: search.sort,
    limit: search.limit,
    offset: search.offset,
    coldkey: search.coldkey,
  };

  return (
    <ValidatorNominatorsTable
      queryOptions={validatorNominatorsQuery(hotkey, nominatorsQueryParams(normalizedSearch))}
      search={normalizedSearch}
      setSearch={setSearch}
    />
  );
}

// NOT a route enum (#10994): ValidatorApyWindow is the UI-computed APY basis
// (7d/30d/90d plus "snapshot"), and this selector offers the trailing three.
// The value overlap with route windows is coincidence, not lineage.
const APY_WINDOWS: ValidatorApyWindow[] = ["7d", "30d", "90d"];

// #8251: ONE APY tile with a 7d/30d/90d window toggle, replacing the three
// side-by-side cards that showed the same figure three times. Windowed values
// come from daily history (same source/order-sensitivity as the old
// ValidatorApyPanel: points are newest-first, latest finite value wins);
// falls back to the latest-snapshot estimate — labeled as such — while
// history is loading or absent.
/** Returns a Measure rather than a tile — it is one entry in the band. */
function useApyMeasure({
  hotkey,
  take,
  snapshotApy,
}: {
  hotkey: string;
  take: number | null;
  snapshotApy: number | null;
}): Measure {
  const [window, setWindow] = useState<ValidatorApyWindow>("30d");
  const results = useQueries({
    queries: APY_WINDOWS.map((w) => ({
      ...validatorHistoryQuery(hotkey, w),
      staleTime: 60_000,
    })),
  });
  const idx = APY_WINDOWS.indexOf(window);
  const points = results[idx]?.data?.data?.points ?? [];
  let rewards: number | null = null;
  for (const p of points) {
    const v = p.rewards_per_1000_tao;
    if (v != null && Number.isFinite(v)) {
      rewards = v;
      break;
    }
  }
  const windowedApy = apyFromRewardsPer1000(rewards, take);
  const value = windowedApy ?? snapshotApy;
  const usingSnapshot = windowedApy == null;
  return {
    label: "Est. APY",
    value: (
      <span className="mg-measure-with-control">
        {formatApyPct(value)}
        <SegmentedToggle<ValidatorApyWindow>
          options={APY_WINDOWS.map((w) => ({ value: w, label: w }))}
          value={window}
          onChange={setWindow}
          ariaLabel="APY window"
          className="border-0 bg-transparent"
        />
      </span>
    ),
    // The control sits WITH the number it changes, which is the whole reason
    // this measure keeps a control at all.
    hint: usingSnapshot ? "latest snapshot · net of take" : `${window} history · net of take`,
  } satisfies Measure;
}

function ValidatorDetail({ hotkey }: { hotkey: string }) {
  const sourceRef = ss58PathSegment(hotkey);
  const detailRes = useSuspenseQuery(validatorDetailQuery(hotkey)).data;
  const detail = detailRes.data;
  const generatedAt = detailRes.meta?.generated_at ?? null;
  const identity = detail.coldkey_identity;
  const hasIdentity = hasValidatorIdentity(identity);
  // #8372: same resolution ladder as the account page's masthead title.
  // displayName feeds string-only props (validatorName, watch label) as well
  // as the JSX page title, so it stays a plain string via resolveAddress
  // rather than the JSX AddressDisplay component.
  const { data: nametags } = useQuery(nametagIndexQuery());
  const resolvedTitle = resolveAddress(hotkey, {
    identityName: hasIdentity ? identity?.name : undefined,
    nametag: nametags?.get(hotkey) ?? null,
    keep: 8,
  });
  const displayName = resolvedTitle.display;
  const snapshotApy = annualizedDelegatorApyPct(
    detail.total_emission_tao,
    detail.total_stake_tao,
    detail.take,
  );
  const apyMeasure = useApyMeasure({ hotkey, take: detail.take, snapshotApy });
  const tab = useActiveTab("subnets");
  // Take is network-wide, not subnet-scoped, so unlike the per-subnet Stake
  // action this belongs at the page level. Hidden entirely (not just
  // internally blocked) until the connected wallet is confirmed to be this
  // validator's owning coldkey -- #5246's own requirement.
  const { wallet } = useWallet();
  const isOwner = !!wallet && !!detail.coldkey && wallet.address === detail.coldkey;
  // #8251: the ONE Stake/Delegate CTA — defaults to the validator's largest-
  // stake subnet (StakeUnstakeModal is (hotkey, netuid)-scoped, and the
  // biggest membership is the natural place a delegator starts).
  const topSubnet = useMemo(
    () =>
      [...detail.subnets].sort((a, b) => (b.stake_alpha ?? 0) - (a.stake_alpha ?? 0))[0] ?? null,
    [detail.subnets],
  );

  return (
    <DataPageStage variant="profile">
      <PageMasthead
        eyebrow="Explorer · validator"
        live
        title={displayName}
        description={
          <span className="block space-y-4">
            <span className="block max-w-2xl text-sm text-ink-muted">
              Cross-subnet performance, nominators, and staking history for one Bittensor validator
              hotkey.
            </span>
            {resolvedTitle.source === "nametag" && resolvedTitle.category ? (
              <Chip tone="muted" title={`Curated nametag · ${resolvedTitle.category}`}>
                {resolvedTitle.category}
              </Chip>
            ) : null}
            {/* Hotkey + coldkey (#6427) get identical, symmetric AddressDisplay
                rows -- the operator name is already the page title, so it
                isn't repeated here. */}
            {}
            {/* #11522: flat and hairline-ruled. It was a rounded, glowing,
                tinted card holding two copyable addresses — the frame was
                louder than the identifiers inside it. */}
            <dl className="max-w-2xl divide-y divide-border border-y border-border">
              <FieldRow label="Hotkey">
                <span className="flex w-full min-w-0 items-center">
                  <AddressDisplay
                    ss58={hotkey}
                    truncate={false}
                    valueClassName="truncate min-w-0"
                    fallback={<>—</>}
                    editable
                  />
                </span>
              </FieldRow>
              <FieldRow label="Coldkey">
                <span className="flex w-full min-w-0 items-center">
                  <AddressDisplay
                    ss58={detail.coldkey}
                    truncate={false}
                    valueClassName="truncate min-w-0"
                    fallback={<span className="text-ink-muted">Not reported</span>}
                    editable
                  />
                </span>
              </FieldRow>
            </dl>
          </span>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {topSubnet ? (
              <StakeUnstakeModal
                hotkey={hotkey}
                netuid={topSubnet.netuid}
                validatorName={hasIdentity ? displayName : undefined}
                trigger={(open) => (
                  <button
                    type="button"
                    onClick={open}
                    className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent-surface px-3.5 py-2 mg-type-caption-lg font-medium text-accent-text transition-colors hover:border-accent/70"
                  >
                    <Coins className="size-3.5" aria-hidden />
                    Delegate
                  </button>
                )}
              />
            ) : null}
            <ActionBar>
              {isOwner ? (
                <TakeManagementModal
                  hotkey={hotkey}
                  ownerColdkey={detail.coldkey}
                  validatorName={hasIdentity ? displayName : undefined}
                  trigger={(open) => (
                    <button
                      type="button"
                      onClick={open}
                      className="inline-flex items-center gap-1.5 rounded px-2 py-1 min-h-8 mg-type-caption font-medium text-ink-muted hover:text-ink-strong hover:bg-surface transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Percent className="size-3" aria-hidden />
                      Manage take
                    </button>
                  )}
                />
              ) : null}
              <WatchStarButton
                kind="validator"
                id={hotkey}
                label={hasIdentity ? displayName : "this validator"}
                iconOnly
              />
              <ShareButton bare iconOnly />
            </ActionBar>
            {isStaleFreshness(generatedAt) ? (
              <StaleBanner
                compact
                generatedAt={generatedAt}
                refreshQueryKeys={[validatorDetailQuery(hotkey).queryKey]}
              />
            ) : null}
          </div>
        }
        caption="explorer / v1"
      />

      <DataPageCanvas variant="profile">
        <DataPageModule kind="profile">
          {/* #6430: the endpoint is schema-stable, so a mistyped or never-registered
          hotkey resolves to a zeroed aggregate and renders a page of zeros that
          looks exactly like a real validator holding nothing. Say so up front. */}
          {isUnrecognizedValidator(detail) ? (
            <div
              role="status"
              className="mb-8 flex items-start gap-3 border-l-2 border-health-warn bg-health-warn/5 px-4 py-3"
            >
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-health-warn" aria-hidden />
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink-strong">
                  This hotkey isn&apos;t a registered validator
                </p>
                <p className="mt-1 max-w-2xl mg-type-caption-lg text-ink-muted">
                  The address is a valid ss58, but it has never been seen validating on any subnet —
                  every figure below reads zero for that reason, not because the validator is idle.
                  It may be mistyped, or a coldkey rather than a hotkey.
                </p>
              </div>
            </div>
          ) : null}

          {/* #11522: one flat band, not six glass cards.
              The old treatment gave every number the same rounded, glowing
              frame, so nothing led and the eye had six equal places to land —
              the generic-dashboard look this redesign exists to remove. Same
              six measures, hairline separators, no radius or shadow. */}
          <MeasureBand
            ariaLabel="Validator summary"
            measures={[
              {
                label: "Total stake",
                value: taoCompact(detail.total_stake_tao),
                // Root (netuid 0) is TAO-denominated with no price exposure;
                // alpha is the sum across every other subnet's own token (#2550).
                hint: `Root ${taoCompact(detail.root_stake_tao)} · Alpha ${taoCompact(detail.alpha_stake_tao)}`,
              },
              apyMeasure,
              {
                label: "Take rate",
                value: formatTakePct(detail.take),
                hint: "commission kept from delegators",
              },
              {
                label: "Active subnets",
                value: formatNumber(detail.subnet_count),
                hint: "validator memberships",
              },
              {
                label: "Nominators",
                value: detail.nominator_count != null ? formatNumber(detail.nominator_count) : "—",
                hint: "distinct coldkeys delegated",
              },
              {
                label: "Avg trust",
                value: scoreStr(detail.avg_validator_trust),
                hint: "mean across subnets",
              },
            ]}
          />

          {/* #11522: the one composition this page can honestly draw.
              Root is TAO-denominated; alpha is the TAO value of stake held
              across subnets. Both are TAO, so they divide one whole.

              There is deliberately NO cross-subnet stake or emission chart
              here: alpha is denominated independently by every subnet, so
              summing or ranking it across netuids compares different tokens
              and produces a chart that looks right and means nothing (the same
              trap #11550 documents). The per-subnet table below keeps those
              figures where they belong — beside their own subnet. */}
          {detail.root_stake_tao != null && detail.alpha_stake_tao != null ? (
            <div className="mb-10">
              <h2 className="mg-profile-section-title">
                <b>Stake split.</b> Where this validator&apos;s TAO sits.
              </h2>
              <CompositionBreakdown
                ariaLabel="Share of this validator's stake held on root versus across subnets"
                slices={[
                  {
                    id: "root",
                    label: "Root (netuid 0)",
                    value: detail.root_stake_tao,
                    valueLabel: taoCompact(detail.root_stake_tao),
                  },
                  {
                    id: "alpha",
                    label: "Across subnets",
                    value: detail.alpha_stake_tao,
                    valueLabel: taoCompact(detail.alpha_stake_tao),
                  },
                ]}
                footnote={`${formatNumber(detail.subnet_count)} validator memberships`}
              />
            </div>
          ) : null}

          <ProfileTabs tabs={[...TABS]} defaultTab="subnets" />

          <div className="mt-6 min-w-0 space-y-8">
            {tab === "subnets" ? (
              <SectionAnchor id="subnets" title="Per-subnet performance" tone="accent">
                <SubnetPerformanceTab subnets={detail.subnets} />
              </SectionAnchor>
            ) : null}
            {tab === "nominators" ? (
              <SectionAnchor
                id="nominators"
                title="Nominators"
                subtitle="Derived from stake-delegation events"
                tone="muted"
              >
                <AsyncPanel
                  context="nominators"
                  fallback={<Skeleton className="h-64 w-full" />}
                  retryQueryKeys={[metagraphedQueryKey("validator-nominators", hotkey)]}
                >
                  <NominatorsSection hotkey={hotkey} />
                </AsyncPanel>
              </SectionAnchor>
            ) : null}
            {tab === "history" ? (
              <SectionAnchor
                id="history"
                title="Stake & rewards over time"
                subtitle="Daily snapshots"
                tone="ink"
              >
                <ValidatorHistoryChart hotkey={hotkey} />
              </SectionAnchor>
            ) : null}
          </div>

          <div className="mt-8">
            <SectionAnchor
              id="watch"
              title="Watch this validator"
              subtitle="Alert on new delegations or stake, via the existing chain alert-triggers API."
              tone="accent"
            >
              <WatchValidatorAlert hotkey={hotkey} />
            </SectionAnchor>
          </div>

          {/* #6432: same placement blocks.$ref.tsx and extrinsics.$hash.tsx use. */}
          <div className="mt-6">
            <Link
              to="/validators"
              className="inline-flex items-center gap-1.5 rounded border border-border bg-card px-2.5 py-1 mg-type-caption font-medium hover:border-ink/30"
            >
              ← All validators
            </Link>
          </div>

          <SectionAnchor
            id="call"
            title="Call this endpoint"
            subtitle="Copy a ready-to-run request for this validator."
          >
            <EndpointSnippet
              rows={[
                { label: "summary", path: `/api/v1/validators/${sourceRef}` },
                { label: "nominators", path: `/api/v1/validators/${sourceRef}/nominators` },
                { label: "history", path: `/api/v1/validators/${sourceRef}/history` },
              ]}
            />
          </SectionAnchor>

          <ApiSourceFooter
            paths={[
              `/api/v1/validators/${sourceRef}`,
              `/api/v1/validators/${sourceRef}/nominators`,
              `/api/v1/validators/${sourceRef}/history`,
            ]}
          />
        </DataPageModule>
      </DataPageCanvas>
    </DataPageStage>
  );
}

// Mirrors blocks.$ref.tsx / extrinsics.$hash.tsx's own FieldRow (#6424) --
// same label/value dl row idiom, copied rather than shared per this
// codebase's per-route convention for small local helpers.
function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
      <dt className="mg-type-caption text-ink-muted sm:w-20 sm:shrink-0">{label}</dt>
      <dd className="min-w-0 w-full sm:flex-1">{children}</dd>
    </div>
  );
}
