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
import type { DirectoryFilters } from "./directory";

export function SubnetDirectoryControls({
  filters,
  domains,
  onChange,
}: {
  filters: DirectoryFilters;
  domains: readonly string[];
  onChange: (patch: Partial<DirectoryFilters>) => void;
}) {
  const [open, setOpen] = useState(false);
  const count =
    Number(Boolean(filters.domain)) + Number(Boolean(filters.health)) + Number(filters.api);
  const reset = () => onChange({ q: "", domain: "", health: "", api: false });
  const options = [
    {
      key: "domain",
      label: "Domain",
      value: filters.domain,
      choices: [
        { value: "", label: "Any domain" },
        ...domains.map((value) => ({ value, label: value })),
      ],
    },
    {
      key: "health",
      label: "Surface health",
      value: filters.health,
      choices: [
        { value: "", label: "Any health" },
        { value: "ok", label: "OK" },
        { value: "warn", label: "Degraded" },
        { value: "down", label: "Down" },
        { value: "unknown", label: "Unknown" },
      ],
    },
    {
      key: "api",
      label: "API spec",
      value: filters.api ? "yes" : "",
      choices: [
        { value: "", label: "Any coverage" },
        { value: "yes", label: "Has an API spec" },
      ],
    },
  ] as const;
  const fields = () =>
    options.map(({ key, label, value, choices }) => {
      const shown =
        value && !choices.some((choice) => choice.value === value)
          ? [...choices, { value, label: value }]
          : choices;
      return (
        <FilterField
          key={key}
          label={label}
          className="min-w-0 gap-2 [&>span]:not-sr-only [&>span]:text-11 [&>span]:text-ink-muted"
        >
          <FilterSelect
            className="min-h-11 min-w-0 appearance-auto!"
            value={value}
            onChange={(event) =>
              onChange(
                key === "api"
                  ? { api: event.target.value === "yes" }
                  : { [key]: event.target.value },
              )
            }
          >
            {shown.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </FilterSelect>
        </FilterField>
      );
    });

  return (
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <label className="grid min-w-0 flex-1 gap-2 text-11 text-ink-muted">
        Search subnets
        <input
          type="search"
          placeholder="Name, UID or slug"
          value={filters.q}
          onChange={(event) => onChange({ q: event.target.value })}
          className="min-h-11 w-full border border-border bg-canvas px-3 text-13 text-ink-strong outline-offset-2 focus-visible:outline-2 focus-visible:outline-focus"
        />
      </label>
      <div className="hidden items-end gap-3 lg:flex">{fields()}</div>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <button
            type="button"
            className="flex min-h-11 min-w-11 items-center justify-center gap-2 border border-border bg-canvas px-3 text-13 lg:hidden"
            aria-label={`Filter subnets${count ? `, ${count} active` : ""}`}
          >
            <SlidersHorizontal width={16} height={16} aria-hidden="true" />
            Filters{count ? ` (${count})` : ""}
          </button>
        </SheetTrigger>
        <SheetContent
          side="bottom"
          className="max-h-[85dvh] overflow-y-auto border-border bg-canvas p-6 text-ink [&>button]:grid [&>button]:min-h-11 [&>button]:min-w-11 [&>button]:place-items-center"
        >
          <SheetTitle>Filter subnets</SheetTitle>
          <SheetDescription>
            Choose domain, observed surface health and API specification coverage.
          </SheetDescription>
          <div className="grid gap-4 py-4">{fields()}</div>
          <div className="flex flex-wrap items-center justify-between gap-3 pb-[env(safe-area-inset-bottom)]">
            <button type="button" className="min-h-11 text-13 text-accent" onClick={reset}>
              Reset all
            </button>
            <button
              type="button"
              className="min-h-11 border border-border px-3 text-13"
              onClick={() => setOpen(false)}
            >
              Show subnets
            </button>
          </div>
        </SheetContent>
      </Sheet>
      {count > 0 || filters.q ? (
        <button type="button" className="min-h-11 text-13 text-accent" onClick={reset}>
          Reset all
        </button>
      ) : null}
    </div>
  );
}
