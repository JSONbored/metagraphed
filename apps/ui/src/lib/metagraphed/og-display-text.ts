// OG display copy is normalized before its code-point budget is applied. Keep
// this tiny module safe for both metadata builders and the lazy image renderer.
// Raw route keys and records never pass through this display-only operation.
export function clampOgText(value: string | null | undefined, max: number): string {
  const text = (value || "").normalize("NFC").trim();
  const characters = Array.from(text);
  if (characters.length <= max) return text;
  const head = characters.slice(0, max - 1);
  const space = head.lastIndexOf(" ");
  const cut = space >= Math.floor(max * 0.6) ? head.slice(0, space) : head;
  return `${cut.join("").replace(/[\s,;:.—–-]+$/u, "")}…`;
}
