# packages/ui-kit extraction — component audit

Classifies every file in `apps/ui/src/components/{ui,metagraphed}/` (144 total, incl. subdirs)
as **extractable** (pure presentational, no app-context dependency — belongs in
`packages/ui-kit`) or **app-only** (routing/data-fetching/business logic — stays in `apps/ui`).
Tracked by [#4859](https://github.com/JSONbored/metagraphed/issues/4859), part of the
[packages/ui-kit epic](https://github.com/JSONbored/metagraphed/issues/4867).

**Method**: every file's imports were checked for `@tanstack/react-router`,
`@tanstack/react-query`, app-specific hooks/contexts, and domain-typed props (a prop typed as a
specific API response shape, e.g. `SubnetProfile`, rather than primitives). 55 of the 144 were
already vetted during the [design-sync work](../.design-sync/NOTES.md) (2026-07-11) and are
carried over here unchanged; this pass covers the remaining 89.

## Totals

| Verdict                                    | Count   |
| ------------------------------------------ | ------- |
| Extractable (clean)                        | 51      |
| Extractable (needs a small refactor first) | 6       |
| App-only                                   | 87      |
| **Total**                                  | **144** |

## Extractable — clean (51)

Already synced (44, see [.design-sync/config.json](../.design-sync/config.json)):

`components/ui/`: `accordion`, `command`, `dialog`, `hover-card`, `popover`, `sheet`, `sonner`,
`tooltip` (8)

`components/metagraphed/`: `accent-band`, `animated-number`, `back-to-top`, `brand-icon`,
`chips`, `copy-button`, `copy-icon-toggle`, `copyable-code`, `density-toggle`,
`download-csv-button`, `eligibility-chip`, `external-link`, `freshness-badge`, `freshness`,
`hover-preview`, `info-tooltip`, `kbd`, `key-chip`, `list-shell`, `page-hero`, `page-section`,
`scroll-reveal`, `section-anchor`, `section-heading`, `share-button`, `table-state`, `time-ago`,
`view-mode-toggle`, `wordmark` (29)

`components/metagraphed/charts/`: `bar-mini`, `donut`, `spark-legend`, `sparkline`, `stat-tile`,
`stat-with-spark`, `treemap-mini` (7)

Newly audited this pass (7):

| Component                    | Reasoning                                                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `discord-icon.tsx`           | Pure SVG icon, zero deps beyond React types                                                                            |
| `search-scope.tsx`           | Controlled `value`/`onChange` chip built on the already-extractable `Popover`                                          |
| `mcp-tools-list.tsx`         | Pure props (`tools[]`), local `useState` only for an expand/collapse toggle                                            |
| `yield-percentile-strip.tsx` | Props are plain optional numbers; depends on 2 sibling `.ts` utility files (not components) that should bundle with it |
| `primary-links-rail.tsx`     | Pure props (URL strings), uses the already-extractable `safeExternalUrl` helper                                        |
| `profile-hero.tsx`           | Fully slot-driven layout (`ReactNode` props + a generic `StatItem[]`), zero domain coupling                            |
| `methodology-callout.tsx`    | Pure props (`generatedAt`/`windowLabel` strings), only pure formatting-function deps                                   |

**Not yet in the live sync scope**: these 7, plus `DailyRollupFreshness` (tracked separately in
[#4872](https://github.com/JSONbored/metagraphed/issues/4872) — added after the sync scope was
pinned). Adding them to `componentSrcMap` is optional polish, not required before the
`packages/ui-kit` migration issues (#4862–#4864) start — those read this manifest, not the sync
config.

## Extractable — needs a small refactor first (6)

Structurally presentational, but their prop signature currently accepts a full domain/API type
(or a hardcoded app constant) instead of primitives. Each needs its signature loosened before it
can live in a domain-agnostic package — the JSX/logic itself doesn't need to change.

| Component                              | Blocker                                                                                                                             | Fix                                                                                            |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `incident-card.tsx`                    | Prop typed `incident: EndpointIncident` (full domain type)                                                                          | Destructure to the ~4 primitive fields it actually reads, or accept a narrower local interface |
| `endpoint-kind-tabs.tsx`               | Prop typed `value: EndpointCategory \| "all"` (domain enum)                                                                         | Accept a generic `string` union passed by the caller instead of importing the domain enum      |
| `endpoint-snippet.tsx`                 | Hardcodes `API_BASE` from `@/lib/metagraphed/config` inside `apiSnippet()`                                                          | Accept `apiBase` as a prop instead of importing the app's constant                             |
| `readiness-scorecard.tsx`              | Prop typed `profile?: SubnetProfile` (full domain type), reaches into many of its fields internally                                 | Larger refactor — extract the specific fields it needs into a local props interface            |
| `schema-snapshot-summary.tsx`          | Prop typed `schema: SchemaInfo` (full domain type)                                                                                  | Same pattern — narrow to a local interface                                                     |
| `explorer-leaderboard-table-shell.tsx` | Prop typed `leaderboardId: ExplorerLeaderboardId` (app-specific string-literal union), used only for a `data-*` test-hook attribute | Accept a plain `string` — the type safety isn't load-bearing here                              |

## App-only (87)

**11 already vetted** (design-sync session): `entity-hover-card`, `panel-shell`, `states`,
`table-controls`, `verify-surface-button`, `charts/activity-heatmap`, `charts/economics-mini`,
`charts/latency-heatmap`, `charts/subnet-pulse-grid`, `charts/validator-subnet-heatmap`,
`states/registry-empty` — all import `@tanstack/react-query` and/or `@tanstack/react-router`
directly.

**68 newly audited, direct `@tanstack/react-router` and/or `@tanstack/react-query` import**:

`account-cell` (router) · `account-history-chart` (query) · `account-position-history-chart`
(query) · `analytics/coverage-funnel` (query) · `analytics/coverage-matrix` (router+query) ·
`analytics/drift-activity` (router) · `analytics/incidents-timeline` (router+query) ·
`analytics/network-pulse-band` (query) · `analytics/registry-depth` (router+query) ·
`analytics/schema-drift-matrix` (router+query) · `analytics/status-mosaic` (router+query) ·
`analytics/uptime-timeline` (query) · `analytics/what-changed-feed` (query) · `api-drawer`
(query) · `app-shell` (router+query) · `ask-box` (query) · `call-module-extrinsics-table`
(router+query) · `command-palette-body` (router+query) · `concentration-panel` (query) ·
`continue-exploring` (router+query) · `economics-panel` (query) · `emission-yield-panel` (query) ·
`endpoint-list` (router) · `error-boundary` (query — `QueryErrorBoundary`) · `evidence-panel`
(query) · `hero-subnet-chips` (router+query) · `incident-strip` (router+query) · `incident-timeline`
(query) · `integrability-board` (query) · `leaderboards` (router+query) · `metagraph-panel`
(query) · `movers-band` (router+query) · `native-only-notice` (query) · `nav-mega-menu-content`
(router+query) · `nav-mega-menu` (router+query) · `nav-omnibox` (router+query) ·
`network-decentralization-panel` (query) · `neuron-detail-card` (router+query) ·
`neuron-history-chart` (query) · `neuron-table` (router) · `operational-panel` (query) ·
`profile-tabs` (router) · `quick-actions-row` (router) · `recent-identity-changes` (router+query) ·
`registry-ticker` (router+query) · `reliability-panel` (query) · `resource-explorer`
(router+query) · `rpc-proxy` (query) · `schema-drift-detail` (router) · `schema-drift`
(router+query) · `shortcuts-popover` (router) · `status-diagnostics` (router+query) ·
`subnet-compare-drawer` (query) · `subnet-filter-context` (router) · `subnet-health-matrix`
(router+query) · `subnet-history-chart` (query) · `subnet-masthead` (router+query) ·
`subnet-price-ticker` (router+query) · `subnet-profile-panel` (router+query) ·
`subnets-compare-drawer` (router+query) · `subnets-saved-views` (router) · `surface-fixture`
(query) · `turnover-panel` (query) · `validator-history-chart` (query) ·
`validator-nominators-table` (query) · `validators-panel` (query) ·
`webhook-subscription-manager` (query) · `yield-panel` (router+query)

**8 newly audited, transitively app-coupled** (no direct router/query import, but genuinely
app-specific — reasoning noted individually since the router/query grep alone doesn't explain
these):

| Component                          | Reasoning                                                                                                                     |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `subnet-pulse-strip.tsx`           | Composes only already-excluded children (`EconomicsMini`, `ActivityHeatmap`, `QueryErrorBoundary`) — meaningless without them |
| `command-palette.tsx`              | Thin lazy-load wrapper around `command-palette-body.tsx` (875 lines of app search/routing infra)                              |
| `api-source-footer.tsx`            | Calls `useRegisterApiSource`, a context hook feeding the app's global API-drawer feature                                      |
| `analytics/time-range-scrub.tsx`   | Consumes `useTimeRange` from the sibling analytics-local context                                                              |
| `analytics/time-range-context.tsx` | _Is_ the context provider/hook itself — state infrastructure, not UI                                                          |
| `endpoints-glance.tsx`             | Imports `EmptyState`/`RECOVERY` from the already-excluded `states.tsx`                                                        |
| `settings-popover.tsx`             | Reads `useTheme`/`useDensity`/`useHealthPalette` — app-wide preference state                                                  |
| `network-switcher.tsx`             | Reads `useApiBase`/`useNetwork` and network config constants — core app infrastructure                                        |

## Re-audit trigger

This manifest is a snapshot as of the commit it's added in. Any new file added to
`apps/ui/src/components/{ui,metagraphed}/` after that point needs the same check
(`grep` for `@tanstack/react-router`/`@tanstack/react-query`, then read for hook/context
coupling and domain-typed props) before assuming either verdict.
