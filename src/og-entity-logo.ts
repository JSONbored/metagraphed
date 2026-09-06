/** First-party identity originals can be PNG, JPEG, GIF or vector SVG. WebP
 * and ICO cannot be decoded by the bundled social-card renderer. */
export interface EntityLogo {
  bytes: ArrayBuffer;
  contentType: string;
}

const LOGO_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/svg+xml",
]);
const MAX_LOGO_BYTES = 512 * 1024;
const LOGO_TIMEOUT_MS = 3000;

/** Match the publisher's 512 KiB bound while also bounding the actual stream.
 * Restrict redirects as well as the initial URL to the existing owned origin;
 * canonical /logos/ assets are direct static files, not redirect endpoints. */
export async function fetchLogoBytes(url: string): Promise<EntityLogo | null> {
  const parsed = new URL(url);
  if (
    parsed.origin !== "https://metagraph.sh" ||
    parsed.username ||
    parsed.password
  )
    return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOGO_TIMEOUT_MS);
  try {
    const response = await fetch(parsed.toString(), {
      signal: controller.signal,
      redirect: "manual",
    });
    const contentType = (response.headers.get("content-type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (
      !response.ok ||
      !LOGO_TYPES.has(contentType) ||
      Number(response.headers.get("content-length")) > MAX_LOGO_BYTES
    ) {
      await response.body?.cancel();
      return null;
    }
    const reader = response.body?.getReader();
    if (!reader) return null;
    // A timeout also cancels a body stalled after successful response headers.
    const cancel = () => {
      void reader.cancel().catch(() => {});
    };
    controller.signal.addEventListener("abort", cancel, { once: true });
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (!controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_LOGO_BYTES) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
    } finally {
      controller.signal.removeEventListener("abort", cancel);
      reader.releaseLock();
    }
    if (controller.signal.aborted || total === 0) return null;
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    // MIME alone must not turn a 200 HTML/error body into a completed logo.
    // This is a format-header check, not a substitute for raster decoding.
    const signature =
      contentType === "image/png"
        ? [137, 80, 78, 71, 13, 10, 26, 10]
        : contentType === "image/jpeg"
          ? [255, 216, 255]
          : contentType === "image/gif"
            ? [71, 73, 70, 56]
            : [];
    if (!signature.every((value, index) => bytes[index] === value)) return null;
    if (contentType === "image/svg+xml") {
      const svg = new TextDecoder().decode(bytes);
      // Embedded bitmap SVGs can paint a blank tile in the Worker. External
      // resources and active document features are outside the logo contract.
      if (
        !/<svg[\s>]/i.test(svg) ||
        /<(?:image|script|foreignObject)[\s/>]|<!\s*(?:DOCTYPE|ENTITY)|<\?xml-stylesheet|@import/i.test(
          svg,
        ) ||
        /\b(?:href|src)\s*=\s*["']\s*(?!#)/i.test(svg) ||
        /url\(\s*["']?\s*(?!#)[^\s"')]/i.test(svg)
      )
        return null;
    }
    return { bytes: bytes.buffer, contentType };
  } finally {
    clearTimeout(timeout);
  }
}
