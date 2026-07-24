import type { ReactNode } from "react";
import { classNames } from "@/lib/format";

export function Kbd({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <kbd
      className={classNames(
        "inline-flex items-center justify-center rounded border border-border bg-paper px-1.5 min-w-[1.25rem] h-5 mg-type-data-sm text-ink-muted shadow-[var(--mg-shadow-hairline-inset)]",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
