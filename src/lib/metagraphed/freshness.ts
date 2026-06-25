/**
 * Centralized freshness formatter — used by StatWithSpark, NoDataSpark,
 * MethodologyCallout and OperationalPanel so every "last-updated" stamp
 * across the app reads the same way.
 */
export function formatFreshness(
  updatedAt?: string | null,
  windowLabel?: string | null,
): string | null {
  const parts: string[] = [];
  if (updatedAt) {
    const t = new Date(updatedAt);
    if (!Number.isNaN(t.getTime())) {
      const diffMs = Date.now() - t.getTime();
      parts.push(`updated ${relative(diffMs)}`);
    }
  }
  if (windowLabel) parts.push(`${windowLabel} window`);
  return parts.length ? parts.join(" · ") : null;
}

export function formatFreshnessAbsolute(updatedAt?: string | null): string | null {
  if (!updatedAt) return null;
  const t = new Date(updatedAt);
  if (Number.isNaN(t.getTime())) return null;
  return t.toLocaleString();
}

export function relative(diffMs: number): string {
  const sec = Math.max(0, Math.round(diffMs / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}
