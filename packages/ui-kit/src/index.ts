import "./styles.css";

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
  HoverCard,
  HoverCardTrigger,
  HoverCardContent,
} from "@/components/ui/hover-card";
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
export {
  SegmentedToggle,
  type SegmentedToggleOption,
} from "@/components/ui/segmented-toggle";
export { Toaster } from "@/components/ui/sonner";
export {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "@/components/ui/tooltip";

export { Skeleton } from "@/components/metagraphed/skeleton";
export { AccentBand } from "@/components/metagraphed/accent-band";
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
  type Density,
  DensityToggle,
} from "@/components/metagraphed/density-toggle";
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
export {
  type FreshnessTier,
  FreshnessIndicator,
  DailyRollupFreshness,
  RealtimeFreshness,
  tierFreshnessLabel,
} from "@/components/metagraphed/freshness";
export { HoverPreview } from "@/components/metagraphed/hover-preview";
export { InfoTooltip } from "@/components/metagraphed/info-tooltip";
export { Kbd } from "@/components/metagraphed/kbd";
export { KeyChip } from "@/components/metagraphed/key-chip";
export { ListShell, LoadMore } from "@/components/metagraphed/list-shell";
export { PageHero } from "@/components/metagraphed/page-hero";
export {
  type EntityHeroProps,
  type EntityHeroStat,
  EntityHero,
} from "@/components/metagraphed/entity-hero";
export { PageSection } from "@/components/metagraphed/page-section";
export { ScrollReveal } from "@/components/metagraphed/scroll-reveal";
export {
  type SectionTone,
  SectionAnchor,
} from "@/components/metagraphed/section-anchor";
export { SectionHeading } from "@/components/metagraphed/section-heading";
export { ShareButton } from "@/components/metagraphed/share-button";
export { ActionBar } from "@/components/metagraphed/action-bar";
export {
  PagerBar,
  type PagerBarProps,
} from "@/components/metagraphed/pager-bar";
export { TableState } from "@/components/metagraphed/table-state";
export { TimeAgo } from "@/components/metagraphed/time-ago";
export {
  type ViewMode,
  ViewModeToggle,
} from "@/components/metagraphed/view-mode-toggle";
export { Wordmark } from "@/components/metagraphed/wordmark";
export { DiscordIcon } from "@/components/metagraphed/discord-icon";
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
  type PrimaryLinksRailProps,
  PrimaryLinksRail,
} from "@/components/metagraphed/primary-links-rail";
export { MethodologyCallout } from "@/components/metagraphed/methodology-callout";
export {
  type BarMiniDatum,
  BarMini,
} from "@/components/metagraphed/charts/bar-mini";
export {
  type CandlestickDatum,
  CandlestickMini,
} from "@/components/metagraphed/charts/candlestick-mini";
export {
  type DonutSegment,
  Donut,
  DonutLegend,
} from "@/components/metagraphed/charts/donut";
export { SparkLegend } from "@/components/metagraphed/charts/spark-legend";
export {
  type SparklinePoint,
  Sparkline,
} from "@/components/metagraphed/charts/sparkline";
export { StatTile } from "@/components/metagraphed/charts/stat-tile";
export {
  StatWithSpark,
  MiniStack,
  MiniRadial,
  DotRow,
  NoDataSpark,
} from "@/components/metagraphed/charts/stat-with-spark";
export {
  type TreemapMiniDatum,
  TreemapMini,
} from "@/components/metagraphed/charts/treemap-mini";

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
  Panel,
  type PanelProps,
  type PanelTone,
} from "@/components/metagraphed/panel";
export {
  SectionLabel,
  type SectionLabelProps,
  type SectionLabelSize,
  type SectionLabelTone,
} from "@/components/metagraphed/section-label";
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
  MetricGrid,
  type MetricGridProps,
} from "@/components/metagraphed/metric-grid";
export {
  PanelHeader,
  type PanelHeaderProps,
} from "@/components/metagraphed/panel-header";
export { Divider, type DividerProps } from "@/components/metagraphed/divider";
export {
  TabStrip,
  type TabStripProps,
  type TabStripItem,
} from "@/components/metagraphed/tab-strip";
export {
  StickyToolbar,
  type StickyToolbarProps,
} from "@/components/metagraphed/sticky-toolbar";
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
  MetaStrip,
  type MetaStripProps,
  type MetaStripItem,
} from "@/components/metagraphed/meta-strip";
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
  PageActions,
  type PageActionsProps,
} from "@/components/metagraphed/page-actions";
export {
  PanelSkeleton,
  type PanelSkeletonProps,
  type PanelSkeletonHeight,
} from "@/components/metagraphed/panel-skeleton";
export {
  MobileCollapse,
  type MobileCollapseProps,
} from "@/components/metagraphed/mobile-collapse";
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
  ChartSkeleton,
  type ChartSkeletonProps,
} from "@/components/metagraphed/chart-skeleton";
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
  isTablistNavKey,
  rovingTabIndex,
  useRovingTablist,
} from "@/hooks/use-roving-tablist";
export { isScrolledPast, useScrolled } from "@/hooks/use-scrolled";
