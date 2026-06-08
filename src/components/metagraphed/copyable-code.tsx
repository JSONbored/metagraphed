import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { classNames } from "@/lib/metagraphed/format";

interface Props {
  value: string;
  label?: string;
  className?: string;
  truncate?: boolean;
}

export function CopyableCode({ value, label, className, truncate = true }: Props) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  };

  return (
    <button
      type="button"
      onClick={onCopy}
      title={value}
      className={classNames(
        "group inline-flex items-center gap-1.5 rounded border border-border bg-card px-2 py-1 text-left font-mono text-[11px] text-ink hover:border-ink/30 transition-colors",
        className,
      )}
    >
      {label ? (
        <span className="text-ink-muted uppercase tracking-wider text-[10px]">{label}</span>
      ) : null}
      <code className={classNames("text-ink-strong", truncate && "truncate max-w-[28ch]")}>
        {value}
      </code>
      {copied ? (
        <Check className="size-3 text-health-ok" />
      ) : (
        <Copy className="size-3 text-ink-muted group-hover:text-ink" />
      )}
    </button>
  );
}
