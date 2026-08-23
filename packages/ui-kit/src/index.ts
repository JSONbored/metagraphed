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

// The Radix/cmdk wrappers publish only the parts a consumer composes with.
// Portals, overlays and closes are internal to Content, and an anchor-less
// Popover is the only shape the design system draws -- exporting them anyway
// invited call sites that assemble the primitive by hand.
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
} from "@/components/ui/popover";
export {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
export { Toaster } from "@/components/ui/sonner";

export { Skeleton } from "@/components/metagraphed/skeleton";
export { BackToTop } from "@/components/metagraphed/back-to-top";
export {
  prefetchBrandIcon,
  type BrandIconProps,
  BrandIcon,
} from "@/components/metagraphed/brand-icon";
export { HealthDot } from "@/components/metagraphed/chips";
export { CopyButton } from "@/components/metagraphed/copy-button";
export { CopyIconToggle } from "@/components/metagraphed/copy-icon-toggle";
export { CopyableCode } from "@/components/metagraphed/copyable-code";
export {
  safeExternalUrl,
  ExternalLink,
} from "@/components/metagraphed/external-link";
export * from "./components/metagraphed/interaction";
export * from "./components/metagraphed/document";
export { markAriaLabel } from "./components/metagraphed/charts/chart-aria";
export { Kbd } from "@/components/metagraphed/kbd";
export { TimeAgo } from "@/components/metagraphed/time-ago";
// The provider is the whole API: with it mounted, every descendant TimeAgo
// drops its own timer and re-renders off one shared clock (#8365).
export { LiveTickerProvider } from "@/components/metagraphed/live-ticker-context";
export { Wordmark } from "@/components/metagraphed/wordmark";
export { DiscordIcon } from "@/components/metagraphed/discord-icon";
export { ClaudeIcon } from "@/components/metagraphed/claude-icon";
export { OpenAIIcon } from "@/components/metagraphed/openai-icon";
export {
  SCOPES,
  type SearchScope,
} from "@/components/metagraphed/search-scope";

// Relocated from apps/ui/.../primitives (2026-07-23): dependency-free design-
// system primitives, moved here so ui-kit's own components can use them too
// (they previously couldn't, since ui-kit may not import from apps/ui).
export {
  Chip,
  type ChipTone,
  type ChipProps,
} from "@/components/metagraphed/chip";
export { Panel, type PanelProps } from "@/components/metagraphed/panel";
export {
  EmptyState,
  type EmptyStateProps,
  type EmptyStateVariant,
} from "@/components/metagraphed/empty-state";
export {
  nextTabIndex,
  rovingTabIndex,
  useRovingGroup,
} from "@/hooks/use-roving-group";
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
  RESIDUAL_KEY,
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
  RankedRails,
  railFill,
  type RankedRailItem,
  type RankedRailsProps,
} from "@/components/metagraphed/charts/ranked-rails";
export {
  MarkerRail,
  markerPosition,
  type MarkerRailItem,
  type MarkerRailProps,
} from "@/components/metagraphed/charts/marker-rail";
export {
  RankGrid,
  type RankGridItem,
  type RankGridProps,
} from "@/components/metagraphed/charts/rank-grid";
export {
  LeaderCards,
  deltaLabel,
  type LeaderCardItem,
  type LeaderCardsProps,
} from "@/components/metagraphed/charts/leader-cards";
export {
  CompositionBreakdown,
  type CompositionBreakdownProps,
  type CompositionSegment,
} from "@/components/metagraphed/charts/composition-breakdown";
export {
  COMPOSITION_SPECIMEN,
  LEADER_SPECIMEN,
  MARKER_SPECIMEN,
  RAIL_SPECIMEN,
} from "@/components/metagraphed/charts/rank-specimens";
export * from "@/components/metagraphed/data-table";
export { LoadMore } from "@/components/metagraphed/load-more";
export {
  FilterField,
  FilterInput,
  FilterSelect,
} from "@/components/metagraphed/filter-controls";
export {
  CompareLedger,
  bestIndices,
  type CompareEntity,
  type CompareGroup,
  type CompareLedgerProps,
  type CompareRow,
} from "@/components/metagraphed/compare-ledger";
