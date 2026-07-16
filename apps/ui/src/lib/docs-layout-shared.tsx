import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: "Metagraphed Docs",
      url: "/",
    },
    githubUrl: "https://github.com/JSONbored/metagraphed",
    // The app already has its own theme toggle (SettingsPopover, synced to
    // the pre-hydration bootstrap script in lib/theme.ts) -- a second one in
    // the docs nav would be redundant and could drift out of sync with it.
    themeSwitch: { enabled: false },
  };
}
