import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export function baseOptions(): BaseLayoutProps {
  return {
    // DocsLayout is nested inside the app's own AppShell (see docs.$.tsx),
    // which already renders the site header -- brand, primary nav, search,
    // network switcher. Fumadocs' own nav row would just be a second,
    // redundant header stacked directly under the real one.
    nav: { enabled: false },
    githubUrl: "https://github.com/JSONbored/metagraphed",
    // The app already has its own theme toggle (SettingsPopover, synced to
    // the pre-hydration bootstrap script in lib/theme.ts) -- a second one in
    // the docs nav would be redundant and could drift out of sync with it.
    themeSwitch: { enabled: false },
  };
}
