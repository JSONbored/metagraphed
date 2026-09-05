import { defaultParseSearch } from "@tanstack/react-router";

/** Every route uses q as text; other parameters keep the router's typed parsing. */
export function parseAppSearch(search: string): Record<string, unknown> {
  const parsed: Record<string, unknown> = defaultParseSearch(search);
  const values = new URLSearchParams(search).getAll("q");
  // Keep JSON-string decoding for existing router-generated links. Numbers,
  // booleans and JSON containers entered directly in a URL are still text.
  // Repeated q parameters retain the router's existing array interpretation.
  if (values.length === 1 && typeof parsed.q !== "string") parsed.q = values[0];
  return parsed;
}
