import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Suspense, useState } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { PageHero } from "@jsonbored/ui-kit";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { Skeleton } from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { BarMini, type BarMiniDatum } from "@/components/metagraphed/charts/bar-mini";
import { isValidSs58 } from "@/lib/metagraphed/accounts";
import { chainSignersQuery } from "@/lib/metagraphed/queries";
import { shortHash } from "@/lib/metagraphed/blocks";
import { formatNumber } from "@/lib/metagraphed/format";

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

/** How many top accounts the activity ranking shows. */
const TOP_ACCOUNTS = 12;
/** Window the `/api/v1/chain/signers` ranking covers (matches the query default). */
const ACTIVITY_WINDOW_DAYS = 7;

/**
 * Top accounts ranked by extrinsics signed in the last 7 days, sourced from the
 * same `/api/v1/chain/signers` feed the explorer's "Most active accounts" table
 * uses — surfaced here as a `BarMini` ranking so the accounts index opens on a
 * live leaderboard instead of a blank lookup box. Each account is a link through
 * to its detail page.
 */
function TopActiveAccounts() {
  const signers = useSuspenseQuery(chainSignersQuery()).data.data.signers;
  const top = signers.slice(0, TOP_ACCOUNTS);

  if (top.length === 0) {
    return (
      <p className="font-mono text-[12px] text-ink-muted">
        No account activity in this window yet.
      </p>
    );
  }

  const bars: BarMiniDatum[] = top.map((s) => ({
    label: shortHash(s.signer) ?? s.signer,
    value: s.tx_count,
  }));

  return (
    <>
      <BarMini data={bars} />
      <ul className="mt-4 flex flex-wrap gap-2">
        {top.map((s) => (
          <li key={s.signer}>
            <Link
              to="/accounts/$ss58"
              params={{ ss58: s.signer }}
              title={s.signer}
              className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 font-mono text-[10px] text-ink-strong hover:border-ink/30 hover:text-accent"
            >
              {shortHash(s.signer) ?? s.signer}
              <span className="tabular-nums text-ink-muted">{formatNumber(s.tx_count)} tx</span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

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
      <section className="mx-auto mt-10 w-full max-w-2xl rounded-lg border border-border bg-card p-5">
        <h2 className="mb-1 font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
          Most active accounts
        </h2>
        <p className="mb-4 font-mono text-[11px] text-ink-muted">
          Ranked by extrinsics signed on-chain in the last {ACTIVITY_WINDOW_DAYS} days — jump
          straight to an account below.
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
