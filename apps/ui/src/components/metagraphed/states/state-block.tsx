import type { ComponentProps } from "react";
import { EmptyState, ErrorState } from "../states";
import { RegistryEmpty } from "./registry-empty";

/**
 * Mechanical enforcement of the empty/error/stale-state decision rule (#3962,
 * #5341), documented in prose above `EmptyState` in `../states.tsx`.
 *
 * The app has three deliberately-distinct "nothing here" primitives —
 * `EmptyState` (subtle dashed list / card-grid / section card), `ErrorState`
 * (a failed query, with its retry), and `RegistryEmpty` (registry provenance
 * with a variant badge + freshness row + evidence link). A table's own empty
 * and error slots take these same elements (#11610), so there is no fourth.
 * Their visual differences are intentional and context-driven, so this wrapper
 * deliberately does NOT collapse them into one look — that would regress every
 * established surface and discard the decision rule's rationale. Instead it
 * makes the rule *executable*: a caller declares the CONTEXT via `kind`, and the
 * wrapper renders exactly the sanctioned primitive for it. Reaching for the
 * wrong treatment now requires deliberately passing the wrong `kind` rather than
 * silently importing whichever primitive is closest to hand — the failure mode
 * the prose rule and the `states.tsx:102-121` guard were written to catch.
 *
 * Each `kind`'s props are the underlying primitive's own props (via
 * `ComponentProps`), so this stays automatically in sync with them:
 *
 *  - `kind="list"`       → `EmptyState`    — general list / card-grid / section emptiness
 *  - `kind="list-error"` → `ErrorState`    — the error partner for a `list` context
 *  - `kind="registry"`   → `RegistryEmpty` — registry-provenance surfaces
 */
export type StateBlockProps =
  | ({ kind: "list" } & ComponentProps<typeof EmptyState>)
  | ({ kind: "list-error" } & ComponentProps<typeof ErrorState>)
  | ({ kind: "registry" } & ComponentProps<typeof RegistryEmpty>);

export function StateBlock(props: StateBlockProps) {
  switch (props.kind) {
    case "list": {
      const { kind: _kind, ...rest } = props;
      return <EmptyState {...rest} />;
    }
    case "list-error": {
      const { kind: _kind, ...rest } = props;
      return <ErrorState {...rest} />;
    }
    case "registry": {
      const { kind: _kind, ...rest } = props;
      return <RegistryEmpty {...rest} />;
    }
  }
}
