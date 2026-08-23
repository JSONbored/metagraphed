import { createFileRoute } from "@tanstack/react-router";

/**
 * Chain hub layout (#8244, emptied by #11619).
 *
 * It rendered a shared masthead and a nine-entry tab strip. Four of those
 * tabs are sections of /chain now and each remaining page owns its own hero,
 * so a layout-level hero would be the SECOND hero on every one of them --
 * and a tab strip whose tabs are anchors on the page below it is two
 * navigations for one destination.
 *
 * No `component` and no `head`, both deliberately. A layout route with no
 * component renders its `<Outlet />` anyway, so declaring one that returns
 * exactly that adds a module-scope component to a file whose only other
 * export is `Route` — which is the react-refresh warning, and nothing else.
 * The head went because all four children (`/chain`, and the blocks,
 * extrinsics and events streams) set their own, so the layout's copy was
 * never rendered and had already drifted: it still described the page as
 * "blocks, extrinsics, events, governance and runtime upgrades" while
 * HUB_COPY, the single source, said something else. A second declaration of
 * a fact only stays right by accident.
 *
 * Detail routes (/blocks/$ref, /extrinsics/$hash) deliberately keep their own
 * URLs — only the index pages consolidate, so every existing deep link, share
 * card and agent-facing path to a specific block or extrinsic still resolves.
 */
export const Route = createFileRoute("/chain")({});
