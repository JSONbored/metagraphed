import {
  HubTabActions,
  HubTabs,
  activeHubTab,
  type HubTab,
} from "@/components/metagraphed/hub-tabs";

/**
 * The Chain hub's tab set (#8244).
 *
 * Nine top-level routes collapsed into one destination. They were always one
 * concept — "what the chain is doing" — split across nine pages that each
 * rebuilt their own heading and preamble, and several of which duplicated each
 * other's stats (the activity charts lived on both /explorer and /blocks;
 * most-active accounts on both /explorer and /leaderboards).
 *
 * The chrome itself now lives in components/metagraphed/hub-tabs (#8302), shared
 * with the APIs hub — this file is just this hub's data.
 */
export type ChainTab = HubTab;

export const CHAIN_TABS: readonly ChainTab[] = [
  {
    to: "/chain",
    label: "Overview",
    blurb:
      "The network at a glance — daily activity, fees, call mix, and the most active accounts, computed live from the chain-direct tiers.",
  },
  {
    to: "/chain/blocks",
    label: "Blocks",
    blurb:
      "Recent blocks indexed directly from the chain — newest first, with author, extrinsic and event counts.",
  },
  {
    to: "/chain/extrinsics",
    label: "Extrinsics",
    blurb:
      "Recent transactions indexed directly from the chain — newest first, with call, signer and result.",
  },
  {
    to: "/chain/events",
    label: "Events",
    blurb:
      "Individual pallet events indexed directly from the chain, distinct from the aggregate activity stats.",
  },
  {
    to: "/chain/governance",
    label: "Governance",
    blurb:
      "Root-origin activity: Sudo calls and the AdminUtils config changes that tune subnet hyperparameters.",
  },
  {
    to: "/chain/emissions",
    label: "Emissions",
    blurb:
      "Where each block's TAO goes — every subnet's share decomposed from price share through the gate, and the split between pool liquidity and chain buys.",
  },
  {
    to: "/chain/analytics",
    label: "Analytics",
    blurb:
      "Stake-flow sankey, concentration & emission trends, and registration economics — computed live from the chain-direct tiers.",
  },
  {
    to: "/chain/runtime",
    label: "Runtime",
    blurb:
      "Spec-version upgrade history from the first-party blocks tier — every upgrade observed, newest first.",
  },
] as const;

export function activeChainTab(pathname: string): ChainTab {
  return activeHubTab(CHAIN_TABS, pathname);
}

export function ChainTabs() {
  return <HubTabs tabs={CHAIN_TABS} ariaLabel="Chain sections" />;
}

export const ChainTabActions = HubTabActions;
