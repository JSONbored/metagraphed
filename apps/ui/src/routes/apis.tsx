import { createFileRoute } from "@tanstack/react-router";

/**
 * APIs hub layout (#8302, emptied by #11622).
 *
 * It rendered a shared `AppShell`, one hero and a four-entry tab strip. Each
 * page owns its own hero now -- they are four different questions, not four
 * views of one -- and the tab strip is a `SectionNav` with `href` items, the
 * same nav primitive every rebuilt page already uses for its own sections.
 *
 * No `component` and no `head`, both deliberately: a layout route with no
 * component renders its `<Outlet />` anyway, and all four children set their
 * own head, so the layout's copy was never rendered.
 *
 * Provider detail (/providers/$slug) deliberately keeps its own URL — only
 * index pages consolidate.
 */
export const Route = createFileRoute("/apis")({});
