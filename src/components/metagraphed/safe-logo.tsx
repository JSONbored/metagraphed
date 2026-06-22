import { useState, type ImgHTMLAttributes } from "react";

interface Props extends Omit<ImgHTMLAttributes<HTMLImageElement>, "onError"> {
  /** Text used to derive initials fallback. */
  fallbackText?: string;
  size?: number;
}

/**
 * <img> with a CORS-safe fallback to an initials avatar. Useful for
 * external provider/subnet logos that may 404 or be blocked.
 */
export function SafeLogo({ src, alt, fallbackText, size = 24, className, ...rest }: Props) {
  const [failed, setFailed] = useState(false);
  const initials =
    (fallbackText ?? alt ?? "?")
      .trim()
      .split(/\s+/)
      .map((w) => w[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?";

  if (!src || failed) {
    return (
      <span
        aria-label={alt}
        className={
          "inline-flex shrink-0 items-center justify-center rounded-full border border-border bg-surface text-[10px] font-mono font-semibold uppercase text-ink-muted " +
          (className ?? "")
        }
        style={{ width: size, height: size }}
      >
        {initials}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      width={size}
      height={size}
      loading="lazy"
      onError={() => setFailed(true)}
      className={className}
      {...rest}
    />
  );
}
