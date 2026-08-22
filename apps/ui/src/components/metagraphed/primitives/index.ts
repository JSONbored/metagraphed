// Most primitives are dependency-free and now live in @jsonbored/ui-kit
// (the shared, app-agnostic component library) so ui-kit's own components
// can use them too. This barrel re-exports them under the same names so
// every existing "@/components/metagraphed/primitives" import site is
// unaffected. The handful still defined locally (below the re-exports)
// genuinely need apps/ui's router/query/hooks and can't move.
export {
  Chip,
  type ChipTone,
  type ChipProps,
  StatusBadge,
  type HealthStatus,
  type StatusBadgeProps,
  Indicator,
  type IndicatorProps,
  FilterField,
  FilterInput,
  FilterSelect,
  FilterToolbar,
  ColumnCustomizer,
  type ColumnCustomizerProps,
  useColumnVisibility,
  defaultVisible,
  type ColumnDef,
  Panel,
  type PanelProps,
  EmptyState,
  type EmptyStateProps,
  type EmptyStateVariant,
  TableSkeleton,
  type TableSkeletonProps,
  type TableSkeletonDensity,
  PanelHeader,
  type PanelHeaderProps,
  Divider,
  type DividerProps,
  DefinitionList,
  type DefinitionListProps,
  type DefinitionItem,
  LoadingPill,
  type LoadingPillProps,
  GhostButton,
  type GhostButtonProps,
  type GhostButtonSize,
  type GhostButtonTone,
  PagerFooter,
  type PagerFooterProps,
  ScrollShadow,
  type ScrollShadowProps,
  ResponsiveTable,
  type ResponsiveTableProps,
  FilterSheet,
  type FilterSheetProps,
  PanelSkeleton,
  type PanelSkeletonProps,
  type PanelSkeletonHeight,
  ReadinessGauge,
  type ReadinessGaugeProps,
  ProvenanceChip,
  QueryBar,
  useQueryBarContext,
  type QueryBarProps,
  type QueryBarSearchProps,
  type QueryBarFilterOption,
  type QueryBarFilterTriggerProps,
  type QueryBarMetaRowProps,
  PanelError,
  type PanelErrorProps,
  QueryProgress,
  type QueryProgressProps,
  FilterChipRow,
  type FilterChipRowProps,
  type FilterChipItem,
  RoutePending,
  type RoutePendingProps,
} from "@jsonbored/ui-kit";

/* Still local: genuinely coupled to apps/ui's router, query, or hooks. */
export { Breadcrumbs } from "./breadcrumbs";
export type { BreadcrumbsProps } from "./breadcrumbs";
export { CopyLinkButton } from "./copy-link-button";
export type { CopyLinkButtonProps } from "./copy-link-button";
export { AsyncPanel } from "./async-panel";
export type { AsyncPanelProps } from "./async-panel";
