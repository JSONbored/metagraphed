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

/**
 * The cron schedules wrangler.jsonc actually DECLARES, parsed.
 *
 * Four suites asserted their cron was scheduled with
 * `readFileSync("wrangler.jsonc", "utf8").includes(`"${CRON}"`)`, each under a
 * message naming a real consequence -- "so this watchdog never runs", "so no
 * projection ever recomputes". A raw substring over this file answers neither
 * question it is asked:
 *
 *   - wrangler.jsonc carries over a thousand comment lines, and the comments
 *     in and around the crons block quote cron expressions to explain the
 *     cadences, so a commented-out or merely documented schedule satisfies the
 *     check while nothing is scheduled. Prose has no compiler.
 *   - a match anywhere in the file passes, including inside another worker's
 *     block or an unrelated array, so the check cannot tell "scheduled" from
 *     "mentioned somewhere".
 *
 * Parsing answers both, and the stripper above is why it can: a regex stripper
 * splices a route glob's trailing slash-star to a cron's star-slash and
 * deletes the config between them, as its own header explains. (Written in
 * words on purpose -- the literal sequence would end this comment, which is
 * the same hazard one level up.) Throws rather than returning empty on a
 * malformed or absent
 * triggers block -- "no crons declared" and "I could not read the crons" are
 * different facts, and only one of them should read as a missing schedule.
 */
/** A JSON object, narrowed so its members can be read without an assertion. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Narrows to `string[]`, so a caller returning it needs no assertion. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((e) => typeof e === "string");
}

export function declaredCrons(source: string): readonly string[] {
  const config: unknown = JSON.parse(stripJsonComments(source));
  const triggers = isRecord(config) ? config.triggers : undefined;
  const crons = isRecord(triggers) ? triggers.crons : undefined;
  if (!Array.isArray(crons))
    throw new TypeError("wrangler.jsonc has no triggers.crons array");
  if (!isStringArray(crons)) {
    const bad = crons.filter((entry) => typeof entry !== "string").length;
    throw new TypeError(
      `wrangler.jsonc triggers.crons holds ${bad} non-string entr${bad === 1 ? "y" : "ies"}`,
    );
  }
  return crons;
}
