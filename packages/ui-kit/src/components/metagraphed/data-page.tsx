import type { ReactNode } from "react";
import { useState } from "react";
import { classNames } from "@/lib/format";

/**
 * Shared frame for explorer, directory, dossier, and analytics routes.
 *
 * These are deliberately structural primitives: they establish the same
 * reading rhythm without forcing every route into the same content template.
 */
export type DataPageStageVariant = "default" | "profile" | "tabs" | "landing";
export type DataPageHeroVariant =
  "directory" | "landing" | "analytics" | "profile";
/** The visual field behind a page title. Kept structural so routes never own backdrop CSS. */
export type DataPageHeroAmbient = "lattice" | "document" | "none";
/** Content heroes read like a document; viewport heroes establish a landing-stage moment. */
export type DataPageHeroHeight = "content" | "viewport";
export type DataPageCanvasVariant =
  "default" | "profile" | "operations" | "landing";
export type DataPageModuleKind =
  "task" | "question" | "operations" | "profile" | "navigation";

export type DataPageSignalTone =
  "brand" | "positive" | "warning" | "negative" | "neutral";

export interface DataPageSignal {
  /** The decision this reading helps someone make, not an internal field name. */
  label: ReactNode;
  value: ReactNode;
  /** Short unit, method, or qualification immediately adjacent to the value. */
  detail?: ReactNode;
  /** The source/window timestamp for this one reading. */
  freshness?: ReactNode;
  /** A 0–1 value rendered as a discrete meter only when that scale is meaningful. */
  level?: number | null;
  tone?: DataPageSignalTone;
}

export interface DataPageTaskPath {
  /** A stable visual index makes a small set of paths scannable without cards. */
  index?: ReactNode;
  title: ReactNode;
  description: ReactNode;
  meta?: ReactNode;
  action: ReactNode;
}

export interface DataPageHandoffProps {
  /** The first-party record or next concrete step for the current task. */
  primary: ReactNode;
  /** A documented external starting point or a truthful unavailable state. */
  secondary: ReactNode;
}

export interface DataPageWindowOption<T extends string> {
  value: T;
  label: ReactNode;
}

export type DataPageHeroTitleLineEmphasis = "focus";

/** A semantic title line that can reveal independently or carry a named visual emphasis. */
export function DataPageHeroTitleLine({
  children,
  emphasis,
}: {
  children: ReactNode;
  emphasis?: DataPageHeroTitleLineEmphasis;
}) {
  return (
    <span className="mg-page-hero-title-line" data-emphasis={emphasis}>
      {children}
    </span>
  );
}

export function DataPageStage({
  children,
  className,
  variant = "default",
}: {
  children: ReactNode;
  className?: string;
  variant?: DataPageStageVariant;
}) {
  return (
    <div
      className={classNames(
        "mg-page-stage",
        variant !== "default" ? `mg-page-stage--${variant}` : undefined,
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface DataPageHeroProps {
  eyebrow?: ReactNode;
  /** Entity icon or compact identifier used by profile-like title fields. */
  identity?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** A short, in-context operational fact. Never a card wall. */
  summary?: ReactNode;
  /** Export, share, or view controls; visually secondary to the task. */
  actions?: ReactNode;
  /** Primary route actions placed with the title rather than in the visual aside. */
  primaryActions?: ReactNode;
  /** A concise data visual or signal rail. It should answer one question. */
  aside?: ReactNode;
  /** Primary task control, such as the homepage command field. */
  children?: ReactNode;
  /** Freshness or identity facts that follow the task, not the title. */
  footer?: ReactNode;
  /** A route-level warning that must appear before the title field. */
  banner?: ReactNode;
  live?: boolean;
  id?: string;
  className?: string;
  variant?: DataPageHeroVariant;
  /** A shared visual treatment, rendered outside the accessibility tree. */
  ambient?: DataPageHeroAmbient;
  /** Makes the hero occupy the visible page plane beneath the application chrome. */
  height?: DataPageHeroHeight;
}

/**
 * An original document field for immersive landing moments. It gives the
 * opening title a quiet, dimensional reading plane without pretending to be
 * live data or delaying first paint.
 */
function DataPageHeroDocumentAmbient() {
  return (
    <div className="mg-page-hero-document" aria-hidden="true">
      <div className="mg-page-hero-document-lattice mg-page-hero-document-lattice--far" />
      <div className="mg-page-hero-document-lattice mg-page-hero-document-lattice--near" />
      <div className="mg-page-hero-document-stipple" />
      <div className="mg-page-hero-document-scan" />
    </div>
  );
}

function DataPageHeroAmbient({ ambient }: { ambient: DataPageHeroAmbient }) {
  if (ambient === "none") return null;
  if (ambient === "document") return <DataPageHeroDocumentAmbient />;
  return <div className="mg-page-hero-field" aria-hidden="true" />;
}

/**
 * A title field with a single restrained activity lattice. The lattice is an
 * orientation cue, not a substitute for a chart, and appears across routes so
 * a directory, landing page, and data report feel like one product.
 */
export function DataPageHero({
  eyebrow,
  identity,
  title,
  description,
  summary,
  actions,
  primaryActions,
  aside,
  children,
  footer,
  banner,
  live = false,
  id,
  className,
  variant = "directory",
  ambient = "lattice",
  height = "content",
}: DataPageHeroProps) {
  return (
    <section
      className={classNames(
        "mg-page-hero",
        `mg-page-hero--${variant}`,
        className,
      )}
      aria-labelledby={id}
      data-ambient={ambient}
      data-height={height}
    >
      <DataPageHeroAmbient ambient={ambient} />
      <div className="mg-page-hero-frame">
        {banner ? <div className="mg-page-hero-banner">{banner}</div> : null}
        <div className="mg-page-hero-content">
          <div className="mg-page-hero-copy">
            {eyebrow ? (
              <span className="mg-page-kicker">
                {live ? (
                  <span className="mg-page-kicker-dot" aria-hidden="true" />
                ) : null}
                {eyebrow}
              </span>
            ) : null}
            <div className="mg-page-hero-heading">
              {identity ? (
                <div className="mg-page-hero-identity">{identity}</div>
              ) : null}
              <h1 id={id}>{title}</h1>
            </div>
            {description ? (
              <div className="mg-page-hero-description">{description}</div>
            ) : null}
            {children ? (
              <div className="mg-page-hero-body">{children}</div>
            ) : null}
            {summary ? (
              <div className="mg-page-hero-summary">{summary}</div>
            ) : null}
            {primaryActions ? (
              <div className="mg-page-hero-primary-actions">
                {primaryActions}
              </div>
            ) : null}
          </div>
          {aside ? <aside className="mg-page-hero-aside">{aside}</aside> : null}
          {!aside && actions ? (
            <div className="mg-page-hero-actions">{actions}</div>
          ) : null}
        </div>
        {footer ? <div className="mg-page-hero-footer">{footer}</div> : null}
      </div>
    </section>
  );
}

/**
 * A quiet, source-aware measurement rail. It deliberately avoids a card wall:
 * each reading carries its own source/window so unrelated values never pretend
 * to be one simultaneous snapshot.
 */
export function DataPageSignalRail({
  label,
  signals,
  className,
}: {
  label: string;
  signals: readonly DataPageSignal[];
  className?: string;
}) {
  const visible = signals.filter(
    (signal) =>
      signal.value !== undefined &&
      signal.value !== null &&
      signal.value !== "",
  );

  if (visible.length === 0) return null;

  return (
    <dl
      className={classNames("mg-page-signal-rail", className)}
      aria-label={label}
    >
      {visible.map((signal, index) => {
        const level =
          typeof signal.level === "number" && Number.isFinite(signal.level)
            ? Math.max(0, Math.min(1, signal.level))
            : null;
        const activeCells = level == null ? 0 : Math.round(level * 10);

        return (
          <div
            key={`${String(signal.label)}-${index}`}
            className="mg-page-signal"
            data-tone={signal.tone ?? "neutral"}
          >
            <dt>{signal.label}</dt>
            <dd>
              <span className="mg-page-signal-value">{signal.value}</span>
              {signal.detail ? <small>{signal.detail}</small> : null}
            </dd>
            {level != null ? (
              <span
                className="mg-page-signal-meter"
                aria-label={`${Math.round(level * 100)}%`}
                role="img"
              >
                {Array.from({ length: 10 }, (_, cell) => (
                  <i
                    key={cell}
                    className={cell < activeCells ? "is-active" : undefined}
                  />
                ))}
              </span>
            ) : null}
            {signal.freshness ? (
              <p className="mg-page-signal-freshness">{signal.freshness}</p>
            ) : null}
          </div>
        );
      })}
    </dl>
  );
}

/** A small set of explicit next paths, designed as a continuous reading list. */
export function DataPageTaskPaths({
  label,
  paths,
  className,
}: {
  label: string;
  paths: readonly DataPageTaskPath[];
  className?: string;
}) {
  return (
    <ol
      className={classNames("mg-page-task-paths", className)}
      aria-label={label}
    >
      {paths.map((path, index) => (
        <li key={`${String(path.title)}-${index}`}>
          <span className="mg-page-task-index" aria-hidden="true">
            {path.index ?? String(index + 1).padStart(2, "0")}
          </span>
          <div className="mg-page-task-copy">
            <h3>{path.title}</h3>
            <p>{path.description}</p>
            {path.meta ? <small>{path.meta}</small> : null}
          </div>
          <div className="mg-page-task-action">{path.action}</div>
        </li>
      ))}
    </ol>
  );
}

/**
 * Two related handoff fields without inventing another card. Used when an
 * explorer can show both its own machine-readable record and the entity's
 * public starting point in the same task context.
 */
export function DataPageHandoff({ primary, secondary }: DataPageHandoffProps) {
  return (
    <div className="mg-page-handoff">
      <div className="mg-page-handoff-primary">{primary}</div>
      <div className="mg-page-handoff-secondary">{secondary}</div>
    </div>
  );
}

/** A ruled canvas that turns related modules into one continuous reading surface. */
export function DataPageCanvas({
  children,
  className,
  variant = "default",
}: {
  children: ReactNode;
  className?: string;
  variant?: DataPageCanvasVariant;
}) {
  return (
    <div
      className={classNames(
        "mg-page-canvas",
        variant !== "default" ? `mg-page-canvas--${variant}` : undefined,
        className,
      )}
    >
      {children}
    </div>
  );
}

interface DataPageModuleProps {
  title?: ReactNode;
  caption?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
  kind?: DataPageModuleKind;
}

/**
 * One task or one analytical question. Rules, alignment, and type establish
 * grouping; routes should not turn each task into its own rounded card.
 */
export function DataPageModule({
  title,
  caption,
  actions,
  children,
  className,
  id,
  kind = "task",
}: DataPageModuleProps) {
  return (
    <section
      id={id}
      className={classNames(
        "mg-page-module",
        `mg-page-module--${kind}`,
        className,
      )}
    >
      {title || caption || actions ? (
        <header className="mg-page-module-heading">
          <div>
            {title ? <h2 className="mg-page-module-title">{title}</h2> : null}
            {caption ? (
              <p className="mg-page-module-caption">{caption}</p>
            ) : null}
          </div>
          {actions ? (
            <div className="mg-page-module-actions">{actions}</div>
          ) : null}
        </header>
      ) : null}
      <div className="mg-page-module-body">{children}</div>
    </section>
  );
}

/**
 * A quiet, keyboard-native disclosure for methodology and advanced context.
 *
 * `lazy` preserves the native details control while deferring expensive
 * children until someone asks for them. Once revealed, the content remains
 * mounted so closing and reopening does not refetch or reset an active tool.
 */
export function DataPageDisclosure({
  id,
  label,
  children,
  className,
  open = false,
  lazy = false,
}: {
  /** Optional canonical destination for a deep-linked disclosed record. */
  id?: string;
  label: ReactNode;
  children: ReactNode;
  className?: string;
  open?: boolean;
  /** Mount children only after this disclosure is first opened. */
  lazy?: boolean;
}) {
  const [hasOpened, setHasOpened] = useState(open);

  return (
    <details
      id={id}
      className={classNames("mg-page-disclosure", className)}
      // Keep ordinary disclosures native/uncontrolled. Hash navigation can
      // reveal one imperatively without a later render forcing it closed;
      // explicit `open` still makes a saved URL's initial destination visible.
      open={open || undefined}
      onToggle={(event) => {
        if (event.currentTarget.open) setHasOpened(true);
      }}
    >
      <summary>{label}</summary>
      {!lazy || hasOpened ? (
        <div className="mg-page-disclosure-content">{children}</div>
      ) : null}
    </details>
  );
}

/**
 * A compact time/filter rail for a single analytical question. It deliberately
 * stays local to the plot it controls, rather than becoming a competing page
 * toolbar.
 */
export function DataPageWindowTabs<T extends string>({
  label,
  options,
  value,
  onValueChange,
  className,
}: {
  label: string;
  options: readonly DataPageWindowOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={classNames("mg-data-window", className)}
    >
      {options.map((option) => {
        const selected = option.value === value;

        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onValueChange(option.value)}
            className={classNames(
              "mg-data-window-button mg-focus-ring",
              selected && "is-active",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
