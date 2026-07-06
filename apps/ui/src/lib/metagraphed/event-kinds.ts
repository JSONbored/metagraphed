// Human-readable event-kind labels + category map for the explorer UI. Mirrors the
// backend EVENT_KIND_CATEGORIES in src/account-events.mjs so the client can group
// and label chain events without duplicating the normalization logic inline.

export type EventKindCategory =
  | "registration"
  | "stake"
  | "serving"
  | "consensus"
  | "delegation"
  | "identity"
  | "governance"
  | "transfer"
  | "other";

/** Category slug for each known on-chain event kind (keep in sync with account-events.mjs). */
export const EVENT_KIND_CATEGORIES: Record<string, EventKindCategory> = {
  NeuronRegistered: "registration",
  NeuronDeregistered: "registration",
  NetworkAdded: "registration",
  NetworkRemoved: "registration",
  RegistrationAllowed: "registration",
  PowRegistrationAllowed: "registration",
  Faucet: "registration",
  StakeAdded: "stake",
  StakeRemoved: "stake",
  StakeMoved: "stake",
  StakeTransferred: "stake",
  AxonServed: "serving",
  PrometheusServed: "serving",
  AxonInfoRemoved: "serving",
  WeightsSet: "consensus",
  RootClaimed: "consensus",
  DelegateAdded: "delegation",
  TakeDecreased: "delegation",
  TakeIncreased: "delegation",
  HotkeySwapped: "identity",
  ColdkeySwapped: "identity",
  ColdkeySwapScheduled: "identity",
  SubnetOwnerHotkeySet: "governance",
  BurnSet: "governance",
  Transfer: "transfer",
};

/** Explorer-facing labels for known event kinds. */
export const EVENT_KIND_LABELS: Record<string, string> = {
  NeuronRegistered: "Neuron registered",
  NeuronDeregistered: "Neuron deregistered",
  NetworkAdded: "Network added",
  NetworkRemoved: "Network removed",
  RegistrationAllowed: "Registration allowed",
  PowRegistrationAllowed: "PoW registration allowed",
  Faucet: "Faucet",
  StakeAdded: "Stake added",
  StakeRemoved: "Stake removed",
  StakeMoved: "Stake moved",
  StakeTransferred: "Stake transferred",
  AxonServed: "Axon served",
  PrometheusServed: "Prometheus served",
  AxonInfoRemoved: "Axon removed",
  WeightsSet: "Weights set",
  RootClaimed: "Root claimed",
  DelegateAdded: "Delegate added",
  TakeDecreased: "Take decreased",
  TakeIncreased: "Take increased",
  HotkeySwapped: "Hotkey swapped",
  ColdkeySwapped: "Coldkey swapped",
  ColdkeySwapScheduled: "Coldkey swap scheduled",
  SubnetOwnerHotkeySet: "Subnet owner hotkey set",
  BurnSet: "Burn set",
  Transfer: "Transfer",
};

/** Short category labels for chips / filters. */
export const EVENT_KIND_CATEGORY_LABELS: Record<EventKindCategory, string> = {
  registration: "Registration",
  stake: "Stake",
  serving: "Serving",
  consensus: "Consensus",
  delegation: "Delegation",
  identity: "Identity",
  governance: "Governance",
  transfer: "Transfer",
  other: "Other",
};

function fallbackEventKindLabel(kind: string): string {
  return kind.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}

export function eventKindCategory(kind: string | null | undefined): EventKindCategory {
  if (!kind) return "other";
  return Object.hasOwn(EVENT_KIND_CATEGORIES, kind) ? EVENT_KIND_CATEGORIES[kind] : "other";
}

export function eventKindLabel(kind: string | null | undefined): string {
  if (!kind) return "Unknown event";
  return Object.hasOwn(EVENT_KIND_LABELS, kind)
    ? EVENT_KIND_LABELS[kind]
    : fallbackEventKindLabel(kind);
}

export function eventKindCategoryLabel(category: EventKindCategory): string {
  return EVENT_KIND_CATEGORY_LABELS[category];
}
