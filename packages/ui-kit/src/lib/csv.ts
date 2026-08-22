/** Append `format=csv` to an API URL, preserving existing query params. */
export function buildCsvDownloadUrl(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("format", "csv");
  return parsed.toString();
}
