/**
 * Append `format=csv` to an API URL, preserving any existing query params.
 */
export function buildCsvExportUrl(url: string, baseUrl = "https://example.com"): string {
  const parsed = new URL(url, baseUrl);
  parsed.searchParams.set("format", "csv");
  if (/^https?:\/\//i.test(url)) {
    return parsed.href;
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/**
 * Start a CSV download without navigating the current SPA view away.
 * Uses a transient anchor (issue #3402: anchor-click equivalent to location.href).
 */
export function triggerCsvDownload(url: string, baseUrl: string, filename?: string): void {
  if (typeof document === "undefined") return;
  const href = buildCsvExportUrl(url, baseUrl);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  if (filename) anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
