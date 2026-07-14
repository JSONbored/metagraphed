import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Suspense, useState } from "react";
import { Search } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { Skeleton } from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { TopActiveAccounts } from "@/components/metagraphed/top-active-accounts";
import { TOP_ACTIVE_ACCOUNTS_WINDOW_DAYS } from "@/components/metagraphed/top-active-accounts-ranking";
import { PageHero } from "@jsonbored/ui-kit";
import { isValidSs58 } from "@/lib/metagraphed/accounts";

export const Route = createFileRoute("/accounts/")({
  head: () => ({
    meta: [
      { title: "Accounts — Metagraphed" },
      {
        name: "description",
        content:
          "Look up a Bittensor account (hotkey or coldkey) — cross-subnet activity, registrations, and first-party chain-event history.",
      },
      { property: "og:title", content: "Accounts — Metagraphed" },
      {
        property: "og:description",
        content:
          "Look up a Bittensor account (hotkey or coldkey) — cross-subnet activity, registrations, and chain-event history.",
      },
    ],
  }),
  component: AccountsPage,
});

function AccountsPage() {
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const trimmed = value.trim();
  const valid = isValidSs58(trimmed);
  const touched = trimmed.length > 0;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    navigate({ to: "/accounts/$ss58", params: { ss58: trimmed } });
  };

  return (
    <AppShell>
      <PageHero
        eyebrow="Explorer"
        live
        title="Accounts"
        description="Look up a Bittensor account by ss58 address (hotkey or coldkey) — its cross-subnet activity, current registrations, and first-party chain-event history."
      />
      <form onSubmit={submit} className="mx-auto w-full max-w-2xl">
        <label
          htmlFor="ss58"
          className="mb-2 block font-mono text-[10px] uppercase tracking-widest text-ink-muted"
        >
          Account address (ss58)
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-muted" />
            <input
              id="ss58"
              type="text"
              inputMode="text"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"
              className="w-full rounded border border-border bg-card py-2.5 pl-9 pr-3 font-mono text-sm text-ink-strong placeholder:text-ink-muted/60 focus:border-ink/30 focus:outline-none min-h-11"
            />
          </div>
          <button
            type="submit"
            disabled={!valid}
            className="inline-flex items-center justify-center gap-1.5 rounded border border-border bg-card px-4 py-2.5 text-sm font-medium hover:border-ink/30 disabled:cursor-not-allowed disabled:opacity-40 min-h-11"
          >
            Look up
          </button>
        </div>
        <p className="mt-2 font-mono text-[11px] text-ink-muted">
          {touched && !valid
            ? "That doesn't look like a valid ss58 address."
            : "Paste a hotkey or coldkey ss58 address to view its activity."}
        </p>
      </form>
      <section
        className="mx-auto mt-10 w-full max-w-2xl rounded-lg border border-border bg-card p-5"
        data-testid="top-active-accounts-section"
      >
        <h2 className="mb-1 font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
          Most active accounts
        </h2>
        <p className="mb-4 font-mono text-[11px] text-ink-muted">
          Ranked by extrinsics signed on-chain in the last {TOP_ACTIVE_ACCOUNTS_WINDOW_DAYS} days —
          jump straight to an account below.
        </p>
        <QueryErrorBoundary>
          <Suspense fallback={<Skeleton className="h-40 w-full" />}>
            <TopActiveAccounts />
          </Suspense>
        </QueryErrorBoundary>
      </section>
      <ApiSourceFooter paths={["/api/v1/accounts/{ss58}", "/api/v1/chain/signers"]} />
    </AppShell>
  );
}
