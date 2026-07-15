import type { ComponentProps } from "react";
import { TableState } from "@jsonbored/ui-kit";
import { EmptyState } from "./states";
import { RegistryEmpty } from "./states/registry-empty";

/**
 * The context a "nothing here" block is rendering in. This is the axis the
 * #3962 decision rule is actually about — callers name the situation, not the
 * component.
 */
export type StateContext = "section" | "table" | "registry";

export type StateBlockProps =
  | ({ context: "section" } & ComponentProps<typeof EmptyState>)
  | ({ context: "table" } & ComponentProps<typeof TableState>)
  | ({ context: "registry" } & ComponentProps<typeof RegistryEmpty>);

/**
 * Single entry point for empty / stale / error blocks (#5341).
 *
 * The app deliberately keeps three primitives with different densities, and
 * `states.tsx` documents a decision rule (#3962) for choosing between them.
 * That rule was prose only, so picking the wrong one stayed a silent mistake.
 *
 * This wrapper makes it mechanical instead: a caller declares the `context`
 * and the union above resolves BOTH the component and its prop type, so the
 * compiler rejects a table-only prop (`onRetry`, `error`) on a plain section,
 * or registry provenance (`evidenceHref`) on a table. The three primitives and
 * their distinct treatments are unchanged — this only removes the choice.
 *
 * Rendered output is identical to calling the primitive directly, so existing
 * call sites keep working and can migrate incrementally.
 *
 * - `section` → {@link EmptyState} — the DEFAULT for general list / card-grid /
 *   section emptiness.
 * - `table` → `TableState` — paginated / query-backed table emptiness that
 *   shares empty / stale / error and a retry CTA with its table.
 * - `registry` → {@link RegistryEmpty} — registry-PROVENANCE content (variant
 *   badge, freshness row, evidence link).
 */
export function StateBlock(props: StateBlockProps) {
  switch (props.context) {
    case "table": {
      const { context: _context, ...rest } = props;
      return <TableState {...rest} />;
    }
    case "registry": {
      const { context: _context, ...rest } = props;
      return <RegistryEmpty {...rest} />;
    }
    default: {
      const { context: _context, ...rest } = props;
      return <EmptyState {...rest} />;
    }
  }
}
