import type { ReactNode } from "react";
import { classNames } from "@/lib/format";

/**
 * Shared frame for explorer, directory, dossier, and analytics routes.
 *
 * These are deliberately structural primitives: they establish the same
 * reading rhythm without forcing every route into the same content template.
 */
export type DataPageStageVariant = "default" | "profile" | "tabs";
export type DataPageHeroVariant = "directory" | "landing" | "analytics";
export type DataPageCanvasVariant = "default" | "profile" | "operations";
export type DataPageModuleKind = "task" | "question" | "operations" | "profile";

export interface DataPageWindowOption<T extends string> {
  value: T;
  label: ReactNode;
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

interface DataPageHeroProps {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** A short, in-context operational fact. Never a card wall. */
  summary?: ReactNode;
  /** Export, share, or view controls; visually secondary to the task. */
  actions?: ReactNode;
  /** Primary task control, such as the homepage command field. */
  children?: ReactNode;
  /** Freshness or identity facts that follow the task, not the title. */
  footer?: ReactNode;
  live?: boolean;
  id?: string;
  className?: string;
  variant?: DataPageHeroVariant;
}

/**
 * A title field with a single restrained activity lattice. The lattice is an
 * orientation cue, not a substitute for a chart, and appears across routes so
 * a directory, landing page, and data report feel like one product.
 */
export function DataPageHero({
  eyebrow,
  title,
  description,
  summary,
  actions,
  children,
  footer,
  live = false,
  id,
  className,
  variant = "directory",
}: DataPageHeroProps) {
  return (
    <section
      className={classNames(
        "mg-page-hero",
        `mg-page-hero--${variant}`,
        className,
      )}
      aria-labelledby={id}
    >
      <div className="mg-page-hero-field" aria-hidden="true" />
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
          <h1 id={id}>{title}</h1>
          {description ? (
            <div className="mg-page-hero-description">{description}</div>
          ) : null}
          {children ? (
            <div className="mg-page-hero-body">{children}</div>
          ) : null}
          {summary ? (
            <div className="mg-page-hero-summary">{summary}</div>
          ) : null}
        </div>
        {actions ? <div className="mg-page-hero-actions">{actions}</div> : null}
      </div>
      {footer ? <div className="mg-page-hero-footer">{footer}</div> : null}
    </section>
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

/** A quiet, keyboard-native disclosure for methodology and advanced context. */
export function DataPageDisclosure({
  label,
  children,
  className,
  open = false,
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
  open?: boolean;
}) {
  return (
    <details
      className={classNames("mg-page-disclosure", className)}
      open={open}
    >
      <summary>{label}</summary>
      <div>{children}</div>
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
