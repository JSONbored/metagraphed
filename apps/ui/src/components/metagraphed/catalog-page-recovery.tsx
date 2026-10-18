import { ApiError } from "@/lib/metagraphed/client";
import { CatalogRestartRequired } from "@/lib/metagraphed/catalog-pages";

/** Keep failed catalog recovery visible beside accepted rows. */
export function CatalogPageRecovery({
  error,
  onRestart,
  pending,
}: {
  error: Error;
  onRestart: () => void;
  pending: boolean;
}) {
  const overBudget = error instanceof ApiError && error.catalogReason === "catalog_budget_exceeded";
  return (
    <div
      role="alert"
      className="whitespace-normal rounded border border-health-warn/30 bg-surface p-3 text-13"
    >
      <p>{error.message}</p>
      <p>Previously accepted rows retained · current freshness unverified.</p>
      {!overBudget ? (
        <button
          type="button"
          onClick={onRestart}
          disabled={pending}
          className="mt-2 min-h-11 rounded border border-border bg-card px-3 py-1.5 font-medium disabled:opacity-60"
        >
          {error instanceof CatalogRestartRequired ? "Restart results" : "Retry"}
        </button>
      ) : null}
    </div>
  );
}
