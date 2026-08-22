import { classNames } from "@/lib/format";

/**
 * What a reader came to a directory to do.
 *
 * A directory that answers all three at once answers none of them: the default
 * view ends up carrying every column, every export, every density and compare
 * control, and a first-time reader cannot tell whether the page is for browsing
 * projects, researching economics, or picking integrations (#11520).
 *
 * These are *task* modes, not view toggles. `ViewMode` (table/grid/matrix) is a
 * different axis and stays available inside the modes that want it — a mode
 * decides which questions the page is answering, a view decides how the rows
 * are drawn.
 */
export type DirectoryMode = "browse" | "research" | "compare";

export interface DirectoryModeOption<T extends string = DirectoryMode> {
  value: T;
  label: string;
  /** One short line naming the job, shown beneath the strip. */
  hint: string;
}

/**
 * The shared vocabulary, in the order a reader meets it. Browse is first and is
 * always the default: it is the only one that assumes no prior knowledge.
 */
export const DIRECTORY_MODES: readonly DirectoryModeOption[] = [
  {
    value: "browse",
    label: "Browse",
    hint: "What each one does, whether it is healthy, and what it exposes.",
  },
  {
    value: "research",
    label: "Research",
    hint: "Every metric, sortable and exportable, with columns you choose.",
  },
  {
    value: "compare",
    label: "Compare",
    hint: "Select rows and read them side by side.",
  },
] as const;

export function isDirectoryMode(value: unknown): value is DirectoryMode {
  return DIRECTORY_MODES.some((mode) => mode.value === value);
}

/**
 * The task switch for a directory route.
 *
 * Deliberately an underlined strip rather than a segmented pill: this is the
 * page's primary decision, and it should read as a heading-level choice rather
 * than as one more utility control sitting beside density and export.
 */
export function DirectoryModeTabs<T extends string = DirectoryMode>({
  mode,
  onChange,
  modes = DIRECTORY_MODES as readonly DirectoryModeOption<T>[],
  ariaLabel = "Directory mode",
  className,
}: {
  mode: T;
  onChange: (mode: T) => void;
  /**
   * Narrow the offer when a route cannot serve one of them — or WIDEN it when a
   * route has a fourth sibling task. /subnets carries "Rankings" here, which
   * used to be a second tab strip stacked directly above this one: two
   * tablists, one nested inside the other, both answering "what am I doing".
   * The vocabulary is per route; the composition is shared.
   */
  modes?: readonly DirectoryModeOption<T>[];
  ariaLabel?: string;
  className?: string;
}) {
  const active = modes.find((entry) => entry.value === mode) ?? modes[0];

  return (
    <div className={classNames("mg-directory-mode", className)}>
      <div
        role="tablist"
        aria-label={ariaLabel}
        className="mg-directory-mode-strip"
      >
        {modes.map(({ value, label }) => {
          const selected = value === mode;
          return (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={selected}
              className="mg-directory-mode-tab mg-focus-ring"
              onClick={() => onChange(value)}
            >
              {label}
            </button>
          );
        })}
      </div>
      {/*
        The hint changes with the mode rather than listing all three at once.
        A permanent legend explaining every mode is the same density problem
        one level up.
      */}
      {active ? (
        <p className="mg-directory-mode-hint" aria-live="polite">
          {active.hint}
        </p>
      ) : null}
    </div>
  );
}
