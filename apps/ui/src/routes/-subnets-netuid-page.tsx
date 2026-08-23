import { useMemo } from "react";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  AnalyticsPage,
  BrandIcon,
  DataTable,
  EntityHero,
  Fact,
  FactSentence,
  Raw,
  RawCode,
  type DataTableColumn,
  type FactCells,
  type FactNodes,
  type RawRow,
} from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { RouterLink } from "@/components/metagraphed/router-link";
import { StakeUnstakeModal } from "@/components/metagraphed/stake-unstake-modal";
import { WatchEntitySheet } from "@/components/metagraphed/watch-entity-sheet";
import { CopyLinkButton } from "@/components/metagraphed/copy-link-button";
import { apiSnippet } from "@/components/metagraphed/endpoint-snippet";
import { taoCompact } from "@/components/metagraphed/neuron-format";
import { MomentumSection } from "@/components/metagraphed/subnet-detail/momentum";
import { EmissionSplitSection } from "@/components/metagraphed/subnet-detail/emission-split";
import { ValidatorsSection } from "@/components/metagraphed/subnet-detail/validators";
import { SurfacesSection } from "@/components/metagraphed/subnet-detail/surfaces";
import { ActivitySection } from "@/components/metagraphed/subnet-detail/activity";
import { ParticipationSection } from "@/components/metagraphed/subnet-detail/participation";
import { PeersSection } from "@/components/metagraphed/subnet-detail/peers";
import {
  emissionRank,
  topValidator,
  type Window,
} from "@/components/metagraphed/subnet-detail/subnet-detail-logic";
import {
  economicsQuery,
  subnetOwnershipHistoryQuery,
  subnetProfileQuery,
  subnetUptimeQuery,
  subnetValidatorsQuery,
} from "@/lib/metagraphed/queries";
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import { formatDecimal, formatNumber, formatPct, formatTao } from "@/lib/metagraphed/format";
import { API_BASE } from "@/lib/metagraphed/config";
import type { SubnetOwnershipChange } from "@/lib/metagraphed/types";
import { Route } from "./subnets.$netuid";

/** The public reads behind this page, for the ⌘J drawer and the Raw block. */
const apiPaths = (netuid: number) => [
  `/api/v1/subnets/${netuid}/profile`,
  `/api/v1/subnets/${netuid}/ohlc`,
  `/api/v1/subnets/${netuid}/history`,
  `/api/v1/subnets/${netuid}/emission-split/history`,
  `/api/v1/subnets/${netuid}/validators`,
  `/api/v1/subnets/${netuid}/surfaces`,
  `/api/v1/subnets/${netuid}/uptime`,
  `/api/v1/subnets/${netuid}/event-summary`,
  `/api/v1/subnets/${netuid}/cost-to-participate`,
  `/api/v1/subnets/${netuid}/registrations`,
  `/api/v1/subnets/${netuid}/ownership-history`,
  `/api/v1/economics`,
];

/** The page's seven questions, in the order it answers them. */
const SECTIONS = [
  { id: "momentum", name: "Momentum" },
  { id: "emission-split", name: "Emission split" },
  { id: "validators", name: "Validators" },
  { id: "surfaces", name: "Surfaces" },
  { id: "activity", name: "Activity" },
  { id: "participation", name: "Participation" },
  { id: "peers", name: "Peers" },
] as const;

const OWNERSHIP_COLUMNS: DataTableColumn<SubnetOwnershipChange>[] = [
  {
    key: "observed_at",
    label: "When",
    kind: "time",
    value: (row) => row.observed_at ?? null,
  },
  { key: "block_number", label: "Block", kind: "number", value: (row) => row.block_number },
  {
    key: "old_coldkey",
    label: "From",
    kind: "identifier",
    value: (row) => row.old_coldkey ?? "—",
  },
  { key: "new_coldkey", label: "To", kind: "identifier", value: (row) => row.new_coldkey ?? "—" },
];

/**
 * Registers this page's reads with the ⌘J drawer.
 *
 * A component, not a hook call in `SubnetDetailPage`: the provider lives
 * INSIDE `AppShell`, which the page renders, so the page's own body is
 * outside the context it needs.
 */
function ApiSources({ paths }: { paths: string[] }) {
  useRegisterApiSource(paths);
  return null;
}

export function SubnetDetailPage() {
  const { netuid } = Route.useParams();
  const { window } = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const paths = useMemo(() => apiPaths(netuid), [netuid]);

  const { data: profileResult } = useSuspenseQuery(subnetProfileQuery(netuid));
  const profile = profileResult.data;
  const economics = useQuery({ ...economicsQuery(), retry: 0 });
  const uptime = useQuery({ ...subnetUptimeQuery(netuid, "90d"), retry: 0 });
  const validators = useQuery({ ...subnetValidatorsQuery(netuid), retry: 0 });
  const ownership = useQuery({ ...subnetOwnershipHistoryQuery(netuid), retry: 0 });

  const rows = economics.data?.data ?? [];
  const row = rows.find((entry) => entry.netuid === netuid) ?? null;
  const rank = emissionRank(rows, netuid);
  const reliability = uptime.data?.data.reliability;
  const uptimePct =
    typeof reliability?.uptime_ratio === "number" ? reliability.uptime_ratio * 100 : null;
  const delegateTarget = topValidator(validators.data?.data.validators ?? []);
  const surfaceCount = profile.surface_count ?? profile.surfaces?.length ?? 0;
  const activeUids =
    (typeof row?.miner_count === "number" ? row.miner_count : 0) +
    (typeof row?.validator_count === "number" ? row.validator_count : 0);
  const name = profile.name ?? profile.native_name ?? `Subnet ${netuid}`;

  const sentence: FactNodes = [
    <Fact key="rank">{rank != null ? `Ranked #${rank} by emission` : "Unranked"}</Fact>,
    <Fact key="surfaces">
      {surfaceCount > 0 ? `${formatNumber(surfaceCount)} surfaces published` : "No surfaces yet"}
    </Fact>,
    <Fact key="uids">
      {row?.max_uids ? `${formatNumber(activeUids)}/${formatNumber(row.max_uids)} UIDs` : "—"}
    </Fact>,
    <Fact key="up">
      {uptimePct != null ? `${formatDecimal(uptimePct, 1)}% up over 90d` : "Never probed"}
    </Fact>,
    <Fact key="registration">
      {row?.registration_allowed === false ? "Registration closed" : "Registration open"}
    </Fact>,
    <Fact key="curation">{profile.curation_level ?? "uncurated"}</Fact>,
  ];

  const cells: FactCells = [
    { label: "Alpha price", value: row ? formatTao(row.alpha_price_tao) : "—" },
    {
      label: "Emission share",
      value: typeof row?.emission_share === "number" ? `${formatPct(row.emission_share, 3)}` : "—",
    },
    { label: "Total stake", value: row ? `${taoCompact(row.total_stake_alpha)} α` : "—" },
    {
      label: "Miners / Validators",
      value: `${formatNumber(row?.miner_count ?? null)} / ${formatNumber(row?.validator_count ?? null)}`,
    },
    { label: "Uptime 90d", value: uptimePct != null ? `${formatDecimal(uptimePct, 1)}%` : "—" },
    {
      label: "Readiness",
      value:
        typeof profile.integration_readiness === "number"
          ? `${profile.integration_readiness}/100`
          : "—",
    },
  ];

  const rawRows: RawRow[] = [
    { label: "netuid", value: String(netuid) },
    { label: "slug", value: profile.slug ?? `sn-${netuid}` },
    ...(row?.owner_coldkey ? [{ label: "Owner coldkey", value: String(row.owner_coldkey) }] : []),
    ...(row?.owner_hotkey ? [{ label: "Owner hotkey", value: String(row.owner_hotkey) }] : []),
    ...(profile.website
      ? [{ label: "Website", value: profile.website, href: profile.website }]
      : []),
    ...(profile.docs ? [{ label: "Docs", value: profile.docs, href: profile.docs }] : []),
    ...(profile.repo ? [{ label: "Repository", value: profile.repo, href: profile.repo }] : []),
    ...(profile.dashboard
      ? [{ label: "Dashboard", value: profile.dashboard, href: profile.dashboard }]
      : []),
    ...paths.map((path) => ({
      label: path.split("/").slice(4).join("/") || "economics",
      value: `${API_BASE}${path}`,
      href: `${API_BASE}${path}`,
    })),
  ];

  return (
    <AppShell>
      <ApiSources paths={paths} />
      <AnalyticsPage
        sections={SECTIONS}
        hero={
          <EntityHero
            crumbs={[{ label: "Subnets", href: "/subnets" }, { label: `SN${netuid}` }]}
            avatar={
              <BrandIcon
                size={40}
                name={name}
                iconUrl={profile.icon_url}
                netuid={netuid}
                subnetSlug={profile.slug}
                decorative
              />
            }
            name={name}
            action={
              delegateTarget?.hotkey ? (
                <StakeUnstakeModal
                  hotkey={delegateTarget.hotkey}
                  netuid={netuid}
                  subnetName={name}
                  validatorName={`UID ${delegateTarget.uid}`}
                  trigger={(open) => (
                    <button type="button" className="mg-hero-action" onClick={open}>
                      Delegate
                    </button>
                  )}
                />
              ) : null
            }
            secondary={
              <>
                <WatchEntitySheet netuid={netuid} name={name} />
                <CopyLinkButton
                  label="Copy link to this subnet"
                  size="sm"
                  className="mg-hero-icon-action"
                />
              </>
            }
            sentence={<FactSentence>{sentence}</FactSentence>}
            cells={cells}
            live={{
              updatedAt: profileResult.meta?.generated_at ?? null,
              source: "chain + registry",
              onRefresh: () => void queryClient.invalidateQueries({ queryKey: ["mg"] }),
            }}
          />
        }
      >
        <MomentumSection
          netuid={netuid}
          window={window}
          onWindow={(next: Window) => void navigate({ search: { window: next }, replace: true })}
        />
        <EmissionSplitSection netuid={netuid} window={window} />
        <ValidatorsSection netuid={netuid} />
        <SurfacesSection netuid={netuid} name={name} />
        <ActivitySection netuid={netuid} />
        <ParticipationSection netuid={netuid} economics={row} />
        <PeersSection netuid={netuid} economics={rows} />
        <Raw rows={rawRows} title={`SN${netuid} identifiers, sources and API`}>
          <RawCode label="curl">
            {apiSnippet("curl", `${API_BASE}/api/v1/subnets/${netuid}/profile`)}
          </RawCode>
          <RawCode label="Uptime badge">
            {`[![SN${netuid} uptime](${API_BASE}/api/v1/subnets/${netuid}/badge.svg)](https://metagraph.sh/subnets/${netuid})`}
          </RawCode>
          {profile.description ? <p className="mg-raw-prose">{profile.description}</p> : null}
          {(ownership.data?.data.ownership_changes ?? []).length > 0 ? (
            <DataTable
              rows={ownership.data?.data.ownership_changes ?? []}
              columns={OWNERSHIP_COLUMNS}
              rowKey={(change) => `${change.block_number}-${change.new_coldkey}`}
              caption={`SN${netuid} ownership history`}
              link={RouterLink}
              source={`sn-${netuid}-ownership`}
              dense
              mobile="cards"
            />
          ) : null}
        </Raw>
      </AnalyticsPage>
    </AppShell>
  );
}
