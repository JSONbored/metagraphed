/**
 * Pure view-models for the Settings page summary strip (#5346).
 *
 * There is no subscription list API and no account model — the strip reports
 * the self-service webhook surface (actions / kinds / auth) so `/settings`
 * opens with the same KPI/StatTile visual weight as sibling utility pages.
 * KPI values are kept short and numeric on purpose: a prior attempt used the
 * literal endpoint path ("/webhooks/subscriptions") as a hero KPI value,
 * which has no whitespace to wrap on and overflowed the KPI grid cell at
 * every tested viewport — the endpoint path already has a safe home in
 * ApiSourceFooter, so it isn't duplicated here.
 */

export const CHANGE_KINDS = ["subnets", "artifacts"] as const;

export type SettingsChangeKind = (typeof CHANGE_KINDS)[number];

export const SETTINGS_SUMMARY_ACTIONS = [
  {
    id: "create",
    label: "Create",
    method: "POST",
    hint: "token-gated",
  },
  {
    id: "lookup",
    label: "Look up",
    method: "GET",
    hint: "by id",
  },
  {
    id: "delete",
    label: "Delete",
    method: "DELETE",
    hint: "secret",
  },
] as const;

export type SettingsSummaryAction = (typeof SETTINGS_SUMMARY_ACTIONS)[number];

/** Loose input shape so callers/tests can pass custom action lists. */
export interface SettingsSummaryActionInput {
  id: SettingsSummaryAction["id"];
  label: string;
  method: string;
  hint: string;
}

export interface SettingsHeroKpi {
  label: string;
  value: string;
  hint: string;
}

export interface SettingsSummaryTile {
  id: SettingsSummaryAction["id"];
  eyebrow: string;
  value: string;
  hint: string;
  tone: "default" | "accent";
}

/**
 * PageHero KPI cells — hairline strip under the hero copy. Every value is a
 * short count (never a raw URL/path) so it never has to wrap or truncate in
 * the hero's large KPI type.
 */
export function buildSettingsHeroKpis(
  actions: readonly SettingsSummaryActionInput[] = SETTINGS_SUMMARY_ACTIONS,
  kinds: readonly string[] = CHANGE_KINDS,
): SettingsHeroKpi[] {
  return [
    {
      label: "Actions",
      value: String(actions.length),
      hint: actions.map((a) => a.label.toLowerCase()).join(" · "),
    },
    {
      label: "Change kinds",
      value: String(kinds.length),
      hint: kinds.join(" · "),
    },
    {
      label: "Auth modes",
      value: "2",
      hint: "token + secret",
    },
  ];
}

/** Compact StatTile row between the hero and the subscription forms. */
export function buildSettingsSummaryTiles(
  actions: readonly SettingsSummaryActionInput[] = SETTINGS_SUMMARY_ACTIONS,
): SettingsSummaryTile[] {
  return actions.map((action, index) => ({
    id: action.id,
    eyebrow: action.label,
    value: action.method,
    hint: action.hint,
    tone: index === 0 ? "accent" : "default",
  }));
}
