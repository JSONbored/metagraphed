/**
 * Pure view-models for the Settings page summary strip (#5346).
 *
 * There is no subscription list API and no account model — the strip reports
 * the self-service webhook surface (actions / kinds / auth) so `/settings`
 * opens with the same KPI visual weight as sibling utility pages.
 */

export const SETTINGS_CHANGE_KINDS = ["subnets", "artifacts"] as const;

export type SettingsChangeKind = (typeof SETTINGS_CHANGE_KINDS)[number];

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
    hint: "by subscription id",
  },
  {
    id: "delete",
    label: "Delete",
    method: "DELETE",
    hint: "secret-gated",
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

/** PageHero KPI cells — hairline strip under the hero copy. */
export function buildSettingsHeroKpis(
  actions: readonly SettingsSummaryActionInput[] = SETTINGS_SUMMARY_ACTIONS,
  kinds: readonly string[] = SETTINGS_CHANGE_KINDS,
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
      label: "Auth",
      value: "token + secret",
      hint: "no account model",
    },
    {
      label: "Endpoint",
      value: "/webhooks/subscriptions",
      hint: "public API",
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
