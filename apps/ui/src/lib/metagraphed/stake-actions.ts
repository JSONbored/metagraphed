export const STAKE_ACTION_EVT = "metagraphed:stake-action";

export type StakeActionKind = "stake" | "unstake" | "move";

export type StakeActionDetail = {
  kind: StakeActionKind;
  hotkey: string;
  netuid?: number;
};

/** Dispatch a stake-flow entry event — consumed by StakeModal (#5242 integration). */
export function requestStakeAction(kind: StakeActionKind, detail: Omit<StakeActionDetail, "kind">) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<StakeActionDetail>(STAKE_ACTION_EVT, {
      detail: { kind, ...detail },
    }),
  );
}
