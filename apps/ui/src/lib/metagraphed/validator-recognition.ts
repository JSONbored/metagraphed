import type { ValidatorDetail } from "@/lib/metagraphed/types";

/** The core signals a validator-detail payload carries for a real validator. */
export type ValidatorRecognitionSignals = Pick<
  ValidatorDetail,
  "subnet_count" | "total_stake_tao" | "nominator_count"
>;

/**
 * True when a `ValidatorDetail` carries no signal that the hotkey was ever seen
 * validating. Kept pure (no JSX, no component imports) so the branches are
 * unit-tested apart from the DOM, mirroring `validator-card-fields.ts`.
 *
 * `GET /api/v1/validators/{hotkey}` is schema-stable: any well-formed ss58
 * resolves to a zeroed aggregate rather than an error (see
 * `validatorDetailQuery`'s contract). That is deliberate on the API side, but
 * it means a mistyped or never-registered hotkey renders a page of unexplained
 * zeros that looks identical to a real validator with nothing staked. This is
 * the frontend-only heuristic that tells the two apart (#6430) — it changes no
 * contract and gates only a notice, never the data.
 *
 * All three signals must be empty together. Any one of them alone is a real
 * state a genuine validator can be in:
 *   - `subnet_count === 0` — deregistered everywhere but still holding stake.
 *   - `total_stake_tao === 0` — fully unstaked but still registered.
 *   - `nominator_count == null` — the low-frequency nominator source simply has
 *     no row yet, which is why this reads `== null` (null *or* absent) rather
 *     than treating a genuine zero-nominator validator as unrecognized.
 */
export function isUnrecognizedValidator(detail: ValidatorRecognitionSignals): boolean {
  return (
    detail.subnet_count === 0 && detail.total_stake_tao === 0 && detail.nominator_count == null
  );
}
