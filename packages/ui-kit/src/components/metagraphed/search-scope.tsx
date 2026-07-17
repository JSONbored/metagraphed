// The search-scope vocabulary shared by the command palette. The popover-based
// SearchScopeChip that used to live here was removed as dead code (#6378): it
// had zero call sites, and its one plausible home -- command-palette-body.tsx's
// scope row -- deliberately renders every scope as a one-click button instead,
// which is the right affordance inside an already-overlaid palette (a popover
// there would hide the options behind an extra click). Only the vocabulary is
// shared; each surface owns its own presentation.
export const SCOPES = [
  { key: "all", label: "All" },
  { key: "subnet", label: "Subnets" },
  { key: "surface", label: "Surfaces" },
  { key: "endpoint", label: "Endpoints" },
  { key: "provider", label: "Providers" },
  { key: "schema", label: "Schemas" },
] as const;

export type SearchScope = (typeof SCOPES)[number]["key"];
