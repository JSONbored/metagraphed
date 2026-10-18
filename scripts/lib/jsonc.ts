// String-aware JSONC comment stripper. Unlike a naive regex, it never treats
// `//`, `/*`, or `*/` INSIDE a string literal as a comment delimiter — essential
// because wrangler.jsonc holds route globs like `"/api/*"` (ends in `/*`) and the
// cron `"*/2 * * * *"` (contains `*/`); a regex stripper would splice from the
// former's `/*` to the latter's `*/` and delete the config in between. Also drops
// trailing commas so JSON.parse accepts the result.
export function stripJsonComments(value: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    const next = value[i + 1];
    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLine = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i += 1;
      continue;
    }
    out += ch;
  }

  // Drop trailing commas (",}" / ",]") outside string literals only. A blanket
  // regex over the whole output spliced commas out of string contents too, so a
  // value like "a, }" lost its comma. Re-walk string-aware; for a removed comma
  // the look-ahead (j) also skips the whitespace up to the closing bracket, so
  // ",\n }" collapses to "}" exactly as the old regex did.
  let result = "";
  inString = false;
  for (let i = 0; i < out.length; i += 1) {
    const ch = out[i];
    if (inString) {
      result += ch;
      if (ch === "\\") {
        result += out[i + 1] ?? "";
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      result += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < out.length && /\s/.test(out[j])) {
        j += 1;
      }
      if (out[j] === "}" || out[j] === "]") {
        i = j - 1;
        continue;
      }
    }
    result += ch;
  }
  return result;
}
