import { isFinneySs58Address } from "./finney-ss58.ts";

// compare_validators/compare-validators (#6035/#6325) share this same cap and
// SS58 validation with parseCompareNetuids/parseCompareNetuidList above --
// one hotkey-list contract for both the REST query string and the MCP array.
export const COMPARE_VALIDATORS_MAX = 16;
const COMPARE_HOTKEYS_PATTERN =
  /^[1-9A-HJ-NP-Za-km-z]{47,48}(,[1-9A-HJ-NP-Za-km-z]{47,48}){0,15}$/;

export function parseCompareHotkeys(hotkeysRaw: unknown): string[] | null {
  if (
    typeof hotkeysRaw !== "string" ||
    !hotkeysRaw ||
    !COMPARE_HOTKEYS_PATTERN.test(hotkeysRaw)
  ) {
    return null;
  }
  const hotkeys: string[] = [];
  const seen = new Set<string>();
  for (const part of hotkeysRaw.split(",")) {
    if (seen.has(part)) continue;
    seen.add(part);
    hotkeys.push(part);
  }
  return hotkeys;
}

export function parseCompareHotkeyList(hotkeys: unknown): string[] | null {
  if (!Array.isArray(hotkeys) || hotkeys.length === 0) return null;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of hotkeys) {
    if (typeof value !== "string" || !isFinneySs58Address(value)) {
      return null;
    }
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  if (result.length > COMPARE_VALIDATORS_MAX) return null;
  return result;
}

