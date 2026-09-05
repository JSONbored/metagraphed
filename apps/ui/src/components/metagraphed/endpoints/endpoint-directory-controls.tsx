import { useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import {
  FilterField,
  FilterSelect,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@jsonbored/ui-kit";
import { ENDPOINT_SEARCH_MAX_LENGTH } from "./endpoints-logic";
import type { EndpointsSearch } from "@/routes/apis.endpoints";

type DirectorySearch = Pick<EndpointsSearch, "q" | "status" | "kind" | "provider">;

export function EndpointDirectoryControls({
  search,
  kinds,
  providers,
  onChange,
  searchError,
}: {
  search: DirectorySearch;
  kinds: string[];
  providers: string[];
  onChange: (patch: Partial<DirectorySearch>) => void;
  searchError?: string;
}) {
  const [open, setOpen] = useState(false);
  const active = Boolean(search.status || search.kind || search.provider);
  const filters = [
    {
      key: "status",
      label: "Status",
      options: [
        { value: "", label: "Any status" },
        { value: "monitored", label: "Monitored only" },
        ...["ok", "degraded", "failed", "unknown"].map((value) => ({ value, label: value })),
      ],
    },
    {
      key: "kind",
      label: "Kind",
      options: [
        { value: "", label: "Any kind" },
        ...kinds.map((value) => ({ value, label: value })),
      ],
    },
    {
      key: "provider",
      label: "Provider",
      options: [
        { value: "", label: "Any provider" },
        ...providers.map((value) => ({ value, label: value })),
      ],
    },
  ] as const;

  const fields = (inSheet = false) =>
    filters.map(({ key, label, options }) => {
      const value = search[key];
      // Facets describe loaded rows. A selected URL value must remain visible
      // while a filtered page loads, fails, or returns no matching records.
      const choices =
        value && !options.some((option) => option.value === value)
          ? [...options, { value, label: value }]
          : options;
      return (
        <FilterField
          key={key}
          label={label}
          className={
            inSheet
              ? "gap-2 [&>span]:not-sr-only [&>span]:text-11 [&>span]:text-ink-muted"
              : undefined
          }
        >
          <FilterSelect
            className={
              inSheet ? "min-h-11 appearance-auto! border-border" : "min-h-11 appearance-auto!"
            }
            value={value}
            onChange={(event) => onChange({ [key]: event.target.value })}
          >
            {choices.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </FilterSelect>
        </FilterField>
      );
    });

  return (
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <label className="grid min-w-0 flex-1 gap-2 text-11 text-ink-muted">
        Search endpoints
        <input
          type="search"
          aria-label="Search endpoints"
          placeholder="Endpoint, provider or kind"
          maxLength={ENDPOINT_SEARCH_MAX_LENGTH}
          aria-invalid={searchError ? true : undefined}
          aria-describedby={searchError ? "endpoint-search-error" : undefined}
          className="min-h-11 w-full border border-border bg-canvas px-3 text-13 text-ink-strong outline-offset-2 focus-visible:outline-2 focus-visible:outline-focus"
          value={search.q}
          onChange={(event) => onChange({ q: event.target.value })}
        />
      </label>
      <div className="hidden items-end gap-3 lg:flex">{fields()}</div>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <button
            type="button"
            className="flex min-h-11 min-w-11 items-center justify-center border border-border bg-canvas text-ink-strong lg:hidden"
            aria-label={`Filter endpoints${active ? ", filters active" : ""}`}
          >
            <SlidersHorizontal width={16} height={16} aria-hidden="true" />
          </button>
        </SheetTrigger>
        <SheetContent
          side="bottom"
          className="max-h-[85dvh] overflow-y-auto border-border bg-canvas p-6 text-ink [&>button]:grid [&>button]:min-h-11 [&>button]:min-w-11 [&>button]:place-items-center"
        >
          <SheetTitle>Filter endpoints</SheetTitle>
          <SheetDescription>Refine the endpoint directory.</SheetDescription>
          <div className="grid gap-4 py-4">{fields(true)}</div>
          <div className="flex flex-wrap items-center justify-between gap-3 pb-[env(safe-area-inset-bottom)]">
            <button
              type="button"
              className="min-h-11 text-13 text-accent"
              onClick={() => onChange({ status: "", kind: "", provider: "" })}
            >
              Reset filters
            </button>
            <button
              type="button"
              className="min-h-11 border border-border px-3 text-13"
              onClick={() => setOpen(false)}
            >
              Show endpoints
            </button>
          </div>
        </SheetContent>
      </Sheet>
      {searchError ? (
        <span
          id="endpoint-search-error"
          role="alert"
          className="basis-full text-13 text-health-down"
        >
          {searchError}
        </span>
      ) : null}
    </div>
  );
}
