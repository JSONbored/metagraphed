// The zone's native Markdown for Agents feature performs the conversion. It
// retains the requested Accept ranges and adds text/html;q=0.001 for SSR.
// Match its explicit Markdown/HTML preference before disabling edge transforms.
export function prefersMarkdown(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;

  let preferred = "";
  let quality = 0;
  for (const range of (request.headers.get("accept") ?? "").split(",")) {
    const [type, ...params] = range.split(";").map((value) => value.trim().toLowerCase());
    // A browser's */* or text/* range does not opt into Markdown conversion.
    if (type !== "text/markdown" && type !== "text/html") continue;
    const weights = params.filter((param) => param.split("=", 1)[0].trim() === "q");
    let weight = 1;
    if (weights.length > 0) {
      const value = weights[0].slice(weights[0].indexOf("=") + 1).trim();
      // Native handling of malformed quality values can still select HTML.
      // Keep the signed HTML protection whenever negotiation is ambiguous.
      if (weights.length !== 1 || !/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value)) {
        return false;
      }
      weight = Number(value);
    }
    // Keeping the earlier range on equal q matches native edge negotiation.
    if (weight > quality) {
      preferred = type;
      quality = weight;
    }
  }
  return preferred === "text/markdown";
}
