import { useMemo } from "react";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  AnalyticsPage,
  EntityHero,
  Fact,
  FactSentence,
  Raw,
  type FactCells,
  type FactNodes,
  type RawRow,
} from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { CopyLinkButton } from "@/components/metagraphed/primitives";
import { PositionsSection } from "@/components/metagraphed/account-detail/positions";
import { FlowSection } from "@/components/metagraphed/account-detail/flow";
import { CounterpartiesSection } from "@/components/metagraphed/account-detail/counterparties";
import { ActivitySection } from "@/components/metagraphed/account-detail/activity";
import { KeysSection } from "@/components/metagraphed/account-detail/keys";
import {
  EVENT_SCAN_CAP,
  fmtCompactTao,
  fmtSignedTao,
  fmtTao,
  type FlowWindow,
} from "@/components/metagraphed/account-detail/account-detail-logic";
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import {
  SUBNETS_ALL_LIMIT,
  accountBalanceQuery,
  accountIdentityQuery,
  accountPositionsQuery,
  accountQuery,
  accountStakeFlowQuery,
  subnetsQuery,
} from "@/lib/metagraphed/queries";
import { formatNumber, formatRelative } from "@/lib/metagraphed/format";
import { API_BASE } from "@/lib/metagraphed/config";
import { Route } from "./accounts.$ss58";

/**
 * Five sections, and Counterparties stands where the issue drafted History.
 *
 * `/accounts/{ss58}/history` answers `day_count: 0` for every account probed
 * (the fixture account, a whale and an active validator coldkey), and
 * `/accounts/{ss58}/subnets` answers `subnet_count: 0` while `/positions`
 * returns 61 live positions for the same address. A section that can only
 * say "no data" is worse than one that answers a question the data supports.
 */
const SECTIONS = [
  { id: "positions", name: "Positions" },
  { id: "flow", name: "Flow" },
  { id: "counterparties", name: "Counterparties" },
  { id: "activity", name: "Activity" },
  { id: "keys", name: "Keys" },
] as const;

const apiPaths = (ss58: string) => [
  `/api/v1/accounts/${ss58}`,
  `/api/v1/accounts/${ss58}/balance`,
  `/api/v1/accounts/${ss58}/positions`,
  `/api/v1/accounts/${ss58}/stake-flow`,
  `/api/v1/accounts/${ss58}/counterparties`,
  `/api/v1/accounts/${ss58}/events`,
  `/api/v1/accounts/${ss58}/children`,
  `/api/v1/accounts/${ss58}/parents`,
  `/api/v1/accounts/${ss58}/identity`,
];

/** Registers this page's reads with the ⌘J drawer, from inside AppShell's provider. */
function ApiSources({ paths }: { paths: string[] }) {
  useRegisterApiSource(paths);
  return null;
}

const short = (ss58: string) => `${ss58.slice(0, 6)}…${ss58.slice(-6)}`;

export function AccountDetailPage() {
  const { ss58 } = Route.useParams();
  const { window } = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const paths = useMemo(() => apiPaths(ss58), [ss58]);

  const { data: summaryResult } = useSuspenseQuery(accountQuery(ss58));
  const summary = summaryResult.data;
  const balance = useQuery({ ...accountBalanceQuery(ss58), retry: 0 });
  const identity = useQuery({ ...accountIdentityQuery(ss58), retry: 0 });
  const positions = useQuery({ ...accountPositionsQuery(ss58), retry: 0 });
  const flow = useQuery({ ...accountStakeFlowQuery(ss58, { window }), retry: 0 });
  const subnets = useQuery({ ...subnetsQuery({ limit: SUBNETS_ALL_LIMIT }), retry: 0 });

  const nameOf = useMemo(() => {
    const map = new Map<number, string>();
    for (const subnet of subnets.data?.data ?? []) {
      map.set(subnet.netuid, subnet.name ?? `Subnet ${subnet.netuid}`);
    }
    return (netuid: number) => map.get(netuid) ?? `SN${netuid}`;
  }, [subnets.data]);

  // `null` when the query has not answered, never 0. A failed positions read
  // rendering "0 positions" is indistinguishable from an account that holds
  // nothing, and the two are opposite facts (#8818).
  const held = positions.data?.data.positions ?? null;
  const staked = held ? held.reduce((acc, position) => acc + (position.stake_tao ?? 0), 0) : null;
  const free = balance.data?.data.balance_tao ?? null;
  const subnetCount = held ? new Set(held.map((position) => position.netuid)).size : null;
  const positionCount = positions.data?.data.position_count ?? null;
  const scanCapped = Boolean(summary.event_scan_capped);
  const name = identity.data?.data.name?.trim() || short(ss58);

  const sentence: FactNodes = [
    <Fact key="free">{`${fmtTao(free, 4)} free`}</Fact>,
    <Fact key="staked">{`${fmtCompactTao(staked)} staked`}</Fact>,
    <Fact key="subnets">
      {subnetCount === null
        ? "positions unavailable"
        : subnetCount > 0
          ? `across ${formatNumber(subnetCount)} subnets`
          : "no live positions"}
    </Fact>,
    <Fact key="first">
      {summary.first_seen_at
        ? `first seen ${formatRelative(summary.first_seen_at)}`
        : "first seen —"}
    </Fact>,
    <Fact key="last">
      {summary.last_seen_at
        ? `last active ${formatRelative(summary.last_seen_at)}`
        : "last active —"}
    </Fact>,
    <Fact key="net">{`net ${fmtSignedTao(flow.data?.data.net_flow_tao ?? null)} ${window}`}</Fact>,
  ];

  const cells: FactCells = [
    { label: "Free balance", value: fmtTao(free, 4) },
    { label: "Staked", value: fmtCompactTao(staked) },
    { label: "Positions", value: positionCount === null ? "—" : formatNumber(positionCount) },
    { label: "Subnets", value: subnetCount === null ? "—" : formatNumber(subnetCount) },
    {
      // Never a bare number above the cap: the summary describes the scanned
      // prefix there, and printing it as a total understates a whale by an
      // unknown amount.
      label: "Events",
      value: scanCapped ? `> ${formatNumber(EVENT_SCAN_CAP)}` : formatNumber(summary.event_count),
    },
    { label: `Net flow ${window}`, value: fmtSignedTao(flow.data?.data.net_flow_tao ?? null) },
  ];

  const rawRows: RawRow[] = [
    { label: "ss58", value: ss58 },
    ...(identity.data?.data.name ? [{ label: "Identity", value: identity.data.data.name }] : []),
    ...(identity.data?.data.url
      ? [{ label: "Identity URL", value: identity.data.data.url, href: identity.data.data.url }]
      : []),
    ...paths.map((path) => ({
      label: path.split("/").slice(5).join("/") || "summary",
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
            crumbs={[{ label: "Accounts", href: "/accounts" }, { label: short(ss58) }]}
            name={name}
            secondary={
              <CopyLinkButton
                label="Copy link to this account"
                size="sm"
                className="mg-hero-icon-action"
              />
            }
            sentence={<FactSentence>{sentence}</FactSentence>}
            cells={cells}
            live={{
              updatedAt: summaryResult.meta?.generated_at ?? null,
              source: "live RPC + chain-direct index",
              onRefresh: () => void queryClient.invalidateQueries({ queryKey: ["mg"] }),
            }}
          />
        }
      >
        <PositionsSection ss58={ss58} nameOf={nameOf} />
        <FlowSection
          ss58={ss58}
          window={window}
          onWindow={(next: FlowWindow) =>
            void navigate({ search: (prev) => ({ ...prev, window: next }), replace: true })
          }
          nameOf={nameOf}
        />
        <CounterpartiesSection ss58={ss58} />
        <ActivitySection
          ss58={ss58}
          nameOf={nameOf}
          kinds={summary.event_kinds ?? []}
          eventCount={summary.event_count}
          scanCapped={scanCapped}
        />
        <KeysSection ss58={ss58} />
        <Raw rows={rawRows} title="Account identifiers, identity and API" />
      </AnalyticsPage>
    </AppShell>
  );
}
