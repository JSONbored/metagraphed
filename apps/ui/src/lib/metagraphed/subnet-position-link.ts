/**
 * Search params that deep-link a subnet-position row to its own neuron card
 * (#6431).
 *
 * `AccountFootprintSection` (accounts.$ss58.tsx) and `SubnetPerformanceTable`
 * (validators.$hotkey.tsx) both render one row per subnet membership, linking
 * `SN{netuid}` to the subnet page while the row's `uid` sits unlinked in the
 * next cell. `subnets.$netuid.tsx` already reads `tab`/`uid` from its search to
 * render a "Neuron UID {uid}" detail card — its own MetagraphPanel/
 * ValidatorsPanel navigate that way internally — so those rows can land on the
 * exact neuron instead of the subnet overview.
 *
 * Returns `undefined` when the row has no uid, which leaves the link exactly as
 * it was: a bare subnet link.
 */
export function subnetPositionSearch(
  uid: number | null | undefined,
): { tab: string; uid: number } | undefined {
  return uid != null ? { tab: "metagraph", uid } : undefined;
}
