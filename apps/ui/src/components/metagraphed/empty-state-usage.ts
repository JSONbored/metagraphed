/**
 * Empty-state component selection rules (#3962).
 *
 * - **EmptyState** — lightweight dashed-border emptiness for inline sections,
 *   charts, side panels, and simple one-off blocks that are not data tables and
 *   do not need registry provenance (freshness/evidence/actions rows).
 * - **TableState** — empty / stale / error blocks for data tables and
 *   table-adjacent lists (including paginated registry tables). Supports retry,
 *   CTA, and ApiError wiring with the shared rounded-xl table chrome.
 * - **RegistryEmpty** — registry catalog surfaces where users need provenance:
 *   freshness hints, evidence/source links, and multiple next-action chips
 *   (e.g. /endpoints, /surfaces, /gaps, subnet gaps panel).
 */
export const EMPTY_STATE_COMPONENT_RULES = {
  EmptyState: "Inline sections, charts, and lightweight panels outside data tables.",
  TableState: "Empty, stale, and error states for data tables and table-adjacent lists.",
  RegistryEmpty: "Registry catalog surfaces with provenance, freshness hints, and evidence links.",
} as const;

export type EmptyStateComponent = keyof typeof EMPTY_STATE_COMPONENT_RULES;

export type EmptyStateContext = "inline-section" | "data-table" | "registry-catalog";

/** Maps a UI context to the component mandated by #3962. */
export function emptyStateComponentFor(context: EmptyStateContext): EmptyStateComponent {
  switch (context) {
    case "data-table":
      return "TableState";
    case "registry-catalog":
      return "RegistryEmpty";
    case "inline-section":
    default:
      return "EmptyState";
  }
}
