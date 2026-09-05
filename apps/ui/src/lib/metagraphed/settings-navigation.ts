import type { SectionNavItem } from "@jsonbored/ui-kit";

export type SettingsGroupId = "appearance" | "watchlists" | "developer";

/** Existing section fragments remain valid, including the /portfolio redirect. */
export function settingsGroupForHash(hash: string): SettingsGroupId {
  switch (hash.replace(/^#/, "")) {
    case "wallet":
    case "portability":
    case "alerts":
      return "watchlists";
    case "keys":
    case "webhooks":
      return "developer";
    default:
      return "appearance";
  }
}

export function settingsNavigation(group: SettingsGroupId): SectionNavItem[] {
  return [
    { id: "appearance", name: "Appearance", href: "/settings#preferences" },
    { id: "watchlists", name: "Watchlists & alerts", href: "/settings#wallet" },
    { id: "developer", name: "Developer access", href: "/settings#keys" },
  ].map((item) => ({ ...item, current: item.id === group }));
}
