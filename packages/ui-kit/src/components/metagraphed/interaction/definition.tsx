import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * The definition-tooltip idiom (#11606): a 16×16 "?" beside a term that opens
 * one sentence from the app's glossary. The glossary itself lives in the app
 * (`apps/ui/src/lib/metagraphed/definitions.ts`) and is mounted once with
 * `DefinitionsProvider`; a `<Definition term="…">` looks its sentence up, and
 * a unit test in the app asserts every term used in TSX exists there.
 *
 * Opens on hover / focus / tap; closes on leave / blur / Escape / outside tap.
 * The box is `role="tooltip"` and linked with `aria-describedby`.
 */
export type Definitions = Readonly<Record<string, string>>;

const DefinitionsContext = createContext<Definitions>({});

export function DefinitionsProvider({
  definitions,
  children,
}: {
  definitions: Definitions;
  children: ReactNode;
}) {
  return (
    <DefinitionsContext.Provider value={definitions}>
      {children}
    </DefinitionsContext.Provider>
  );
}

export function useDefinition(term: string): string | undefined {
  return useContext(DefinitionsContext)[term];
}

export interface DefinitionProps {
  term: string;
  /** Overrides the glossary sentence (specimens, one-off copy). */
  sentence?: string;
  /** Open the box to the left when the trigger sits at a right edge. */
  align?: "start" | "end";
  className?: string;
  /**
   * A custom trigger (a chip, a legend, a sparkline) instead of the 16×16
   * "?". The children are the visible term; the box describes them.
   */
  children?: ReactNode;
}

export function Definition({
  term,
  sentence,
  align = "start",
  className,
  children,
}: DefinitionProps) {
  const fromGlossary = useDefinition(term);
  const text = sentence ?? fromGlossary;
  const id = useId();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const pointerType = useRef<string>("mouse");

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root && event.target instanceof Node && !root.contains(event.target))
        close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, close]);

  if (!text) return children ? <>{children}</> : null;

  return (
    <span
      ref={rootRef}
      className={["mg-definition", className].filter(Boolean).join(" ")}
    >
      <button
        type="button"
        className={children ? "mg-definition-trigger" : "mg-definition-button"}
        aria-label={children ? undefined : `What is ${term}`}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onPointerDown={(event) => {
          pointerType.current = event.pointerType || "mouse";
        }}
        onPointerEnter={(event) => {
          if (event.pointerType !== "touch") setOpen(true);
        }}
        onPointerLeave={(event) => {
          if (event.pointerType !== "touch") setOpen(false);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => {
          if (pointerType.current === "touch") setOpen((v) => !v);
        }}
      >
        {children ?? "?"}
      </button>
      {open ? (
        <span
          id={id}
          role="tooltip"
          className="mg-definition-tip"
          data-align={align}
          data-mg-tooltip=""
        >
          <strong>{term}</strong>
          {text}
        </span>
      ) : null}
    </span>
  );
}
