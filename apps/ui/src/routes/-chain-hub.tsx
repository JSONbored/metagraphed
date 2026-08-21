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
    blurb: "Live activity, fees, call mix, and active accounts.",
  },
  {
    to: "/chain/blocks",
    label: "Blocks",
    blurb: "Newest blocks with authors, extrinsics, and events.",
  },
  {
    to: "/chain/extrinsics",
    label: "Extrinsics",
    blurb: "Newest transactions with calls, signers, and outcomes.",
  },
  {
    to: "/chain/events",
    label: "Events",
    blurb: "Runtime events, newest first.",
  },
  {
    to: "/chain/governance",
    label: "Governance",
    blurb: "Root calls and parameter changes.",
  },
  {
    to: "/chain/emissions",
    label: "Emissions",
    blurb: "How each block's rewards move through the network.",
  },
  {
    to: "/chain/analytics",
    label: "Analytics",
    blurb: "Stake flow, concentration, emissions, and registration economics.",
  },
  {
    to: "/chain/runtime",
    label: "Runtime",
    blurb: "Runtime upgrade history, newest first.",
  },
] as const;

export function activeChainTab(pathname: string): ChainTab {
  return activeHubTab(CHAIN_TABS, pathname);
}

export function ChainTabs({ className }: { className?: string }) {
  return <HubTabs tabs={CHAIN_TABS} ariaLabel="Chain sections" className={className} />;
}

export const ChainTabActions = HubTabActions;
