/**
 * The change-feed kinds a webhook subscription can filter on.
 *
 * Mirrors `VALID_CHANGE_KINDS` in `src/webhooks.ts`, which is a module-private
 * `Set` on the Worker side and so cannot be imported here — the API rejects
 * anything outside it at subscription time, which is what keeps this list
 * honest.
 */
export const CHANGE_KINDS = ["subnets", "artifacts"] as const;

export type SettingsChangeKind = (typeof CHANGE_KINDS)[number];
