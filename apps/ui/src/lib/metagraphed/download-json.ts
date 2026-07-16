/**
 * Fetches `url` and saves the response body as a local file named `filename`.
 * A plain anchor click can't force this cross-origin: the HTML `download`
 * attribute only applies to same-origin (or already-local blob:) URLs, and
 * `/api/v1/openapi.json` sends no `Content-Disposition: attachment` header
 * for a same-tab navigation to fall back on. Fetching the body into a blob:
 * URL first sidesteps both.
 */
export async function downloadJsonFromUrl(url: string, filename: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
