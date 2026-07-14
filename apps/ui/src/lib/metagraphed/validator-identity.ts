import type { ColdkeyIdentity } from "./types";

/**
 * Whether a validator's coldkey carries a real, displayable operator identity
 * (declared on-chain AND with a non-empty name). When this is false the hero's
 * title, the identity chip, and the copyable hotkey would all just repeat the
 * same hotkey, so callers gate the redundant chip on this predicate.
 */
export function hasValidatorIdentity(identity: ColdkeyIdentity | null | undefined): boolean {
  return Boolean(identity?.has_identity && identity.name && identity.name.trim());
}
