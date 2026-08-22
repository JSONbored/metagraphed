import "./styles.css";

// Class-assembly helpers (#7847). Two distinct semantics, both canonical
// here -- apps/ui's own copies re-export these rather than redefining them:
//   - classNames: cheap Boolean-filter-and-join, no Tailwind conflict
//     resolution. Use for static class assembly.
//   - cn: clsx + tailwind-merge, resolves conflicting Tailwind utilities
//     (e.g. two different `px-*` values collapse to the last one). Use only
//     where callers may pass conflicting utilities that must merge --
//     typically prop-accepting components forwarding a caller `className`
//     alongside the component's own classes.
export { classNames } from "@/lib/format";
export { cn } from "@/lib/utils";

export {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
} from "@/components/ui/command";
export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
export {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverAnchor,
} from "@/components/ui/popover";
export {
  Sheet,
  SheetPortal,
  SheetOverlay,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
export { Toaster } from "@/components/ui/sonner";

export { Skeleton } from "@/components/metagraphed/skeleton";
export { AnimatedNumber } from "@/components/metagraphed/animated-number";
export { BackToTop } from "@/components/metagraphed/back-to-top";
export {
  prefetchBrandIcon,
  type BrandIconProps,
  BrandIcon,
} from "@/components/metagraphed/brand-icon";
export {
  HealthDot,
  HealthPill,
  CurationChip,
  ReviewChip,
  CandidateChip,
} from "@/components/metagraphed/chips";
export { CopyButton } from "@/components/metagraphed/copy-button";
export { CopyIconToggle } from "@/components/metagraphed/copy-icon-toggle";
export { CopyableCode } from "@/components/metagraphed/copyable-code";
export {
  DownloadCsvButton,
  buildCsvDownloadUrl,
} from "@/components/metagraphed/download-csv-button";
export {
  type PoolEligibility,
  EligibilityChip,
} from "@/components/metagraphed/eligibility-chip";
export {
  safeExternalUrl,
  ExternalLink,
} from "@/components/metagraphed/external-link";
export * from "./components/metagraphed/interaction";
export * from "./components/metagraphed/document";
export { markAriaLabel } from "./components/metagraphed/charts/chart-aria";
export { Kbd } from "@/components/metagraphed/kbd";
export { KeyChip } from "@/components/metagraphed/key-chip";
export { ListShell, LoadMore } from "@/components/metagraphed/list-shell";
export {
  ShareButton,
  SHARE_COPIED_EVENT,
} from "@/components/metagraphed/share-button";
export {
  PagerBar,
  type PagerBarProps,
} from "@/components/metagraphed/pager-bar";
export { TableState } from "@/components/metagraphed/table-state";
export { TimeAgo } from "@/components/metagraphed/time-ago";
export {
  LiveTickerProvider,
  useLiveTicker,
} from "@/components/metagraphed/live-ticker-context";
export {
  type ViewMode,
  ViewModeToggle,
} from "@/components/metagraphed/view-mode-toggle";
export { Wordmark } from "@/components/metagraphed/wordmark";
export { DiscordIcon } from "@/components/metagraphed/discord-icon";
export { ClaudeIcon } from "@/components/metagraphed/claude-icon";
export { OpenAIIcon } from "@/components/metagraphed/openai-icon";
export {
  SCOPES,
  type SearchScope,
} from "@/components/metagraphed/search-scope";
export { McpToolsList } from "@/components/metagraphed/mcp-tools-list";
export { fmtYield } from "@/components/metagraphed/yield-format";
export {
  type YieldPercentileStripProps,
  YieldPercentileStrip,
} from "@/components/metagraphed/yield-percentile-strip";
export {
  type BarMiniDatum,
  BarMini,
} from "@/components/metagraphed/charts/bar-mini";
export {
  type DonutSegment,
  Donut,
  DonutLegend,
} from "@/components/metagraphed/charts/donut";
export {
  type TreemapMiniDatum,
  TreemapMini,
} from "@/components/metagraphed/charts/treemap-mini";
export {
  type SankeyNode,
  type SankeyLink,
  layoutSankey,
  SankeyMini,
} from "@/components/metagraphed/charts/sankey-mini";

// Relocated from apps/ui/.../primitives (2026-07-23): dependency-free design-
// system primitives, moved here so ui-kit's own components can use them too
// (they previously couldn't, since ui-kit may not import from apps/ui).
// apps/ui's primitives/index.ts re-exports these under the same names.
export {
  Chip,
  type ChipTone,
  type ChipProps,
} from "@/components/metagraphed/chip";
export {
  StatusBadge,
  type HealthStatus,
  type StatusBadgeProps,
} from "@/components/metagraphed/status-badge";
export {
  Indicator,
  type IndicatorProps,
} from "@/components/metagraphed/indicator";
export {
  FilterField,
  FilterInput,
  FilterSelect,
  FilterToolbar,
} from "@/components/metagraphed/filter-toolbar";
export {
  ColumnCustomizer,
  type ColumnCustomizerProps,
} from "@/components/metagraphed/column-customizer";
export {
  useColumnVisibility,
  defaultVisible,
  type ColumnDef,
} from "@/components/metagraphed/use-column-visibility";
export {
  TableColGroup,
  columnWidths,
} from "@/components/metagraphed/table-colgroup";
export { Panel, type PanelProps } from "@/components/metagraphed/panel";
export {
  EmptyState,
  type EmptyStateProps,
  type EmptyStateVariant,
} from "@/components/metagraphed/empty-state";
export {
  TableSkeleton,
  type TableSkeletonProps,
  type TableSkeletonDensity,
} from "@/components/metagraphed/table-skeleton";
export {
  PanelHeader,
  type PanelHeaderProps,
} from "@/components/metagraphed/panel-header";
export { Divider, type DividerProps } from "@/components/metagraphed/divider";
export {
  DefinitionList,
  type DefinitionListProps,
  type DefinitionItem,
} from "@/components/metagraphed/definition-list";
export {
  LoadingPill,
  type LoadingPillProps,
} from "@/components/metagraphed/loading-pill";
export {
  GhostButton,
  type GhostButtonProps,
  type GhostButtonSize,
  type GhostButtonTone,
} from "@/components/metagraphed/ghost-button";
export {
  PagerFooter,
  type PagerFooterProps,
} from "@/components/metagraphed/pager-footer";
export {
  ScrollShadow,
  type ScrollShadowProps,
} from "@/components/metagraphed/scroll-shadow";
export {
  ResponsiveTable,
  type ResponsiveTableProps,
} from "@/components/metagraphed/responsive-table";
export {
  FilterSheet,
  type FilterSheetProps,
} from "@/components/metagraphed/filter-sheet";
export {
  PanelSkeleton,
  type PanelSkeletonProps,
  type PanelSkeletonHeight,
} from "@/components/metagraphed/panel-skeleton";
export {
  ReadinessGauge,
  type ReadinessGaugeProps,
} from "@/components/metagraphed/readiness-gauge";
export { ProvenanceChip } from "@/components/metagraphed/provenance-chip";
export {
  QueryBar,
  useQueryBarContext,
  type QueryBarProps,
  type QueryBarSearchProps,
  type QueryBarFilterOption,
  type QueryBarFilterTriggerProps,
  type QueryBarMetaRowProps,
} from "@/components/metagraphed/query-bar";
export {
  PanelError,
  type PanelErrorProps,
} from "@/components/metagraphed/panel-error";
export {
  QueryProgress,
  type QueryProgressProps,
} from "@/components/metagraphed/query-progress";
export {
  FilterChipRow,
  type FilterChipRowProps,
  type FilterChipItem,
} from "@/components/metagraphed/filter-chip-row";
export {
  RoutePending,
  type RoutePendingProps,
} from "@/components/metagraphed/route-pending";
export {
  nextTabIndex,
  rovingTabIndex,
  useRovingGroup,
} from "@/hooks/use-roving-group";
export { isScrolledPast, useScrolled } from "@/hooks/use-scrolled";
export {
  StackedColumns,
  stackedSpecimen,
  type StackedColumn,
  type StackedColumnsProps,
  type StackedSegment,
} from "@/components/metagraphed/charts/stacked-columns";
export {
  LineWithWindow,
  formatLineDate,
  lineSpecimen,
  type LineWithWindowProps,
} from "@/components/metagraphed/charts/line-with-window";
export {
  CHART_RAMP_SIZE,
  OTHER_COLOR,
  OTHER_KEY,
  SeriesPaletteRegistry,
  collapseOther,
  type SeriesPalette,
} from "@/components/metagraphed/charts/series-palette";
export {
  LINE_VIEWBOX,
  monthTicks,
  placePoints,
  smoothPath,
  windowDelta,
  windowPoints,
  type LinePoint,
  type LineWindow,
  type WindowDelta,
} from "@/components/metagraphed/charts/line-geometry";
export { momentumAriaLabel } from "@/components/metagraphed/charts/chart-aria";
export {
  TrendDelta,
  trendDeltaOf,
  type TrendDeltaProps,
} from "@/components/metagraphed/charts/trend-delta";
export {
  Provenance,
  provenanceSentence,
  type ProvenanceProps,
} from "@/components/metagraphed/interaction/provenance";
