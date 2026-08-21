import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Search, Wallet } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { Skeleton } from "@/components/metagraphed/states";
import { TopActiveAccounts } from "@/components/metagraphed/top-active-accounts";
import { TOP_ACTIVE_ACCOUNTS_WINDOW_DAYS } from "@/components/metagraphed/top-active-accounts-ranking";
import { ActionBar, ShareButton } from "@jsonbored/ui-kit";
import {
  AsyncPanel,
  DataPageCanvas,
  DataPageHero,
  DataPageModule,
  DataPageStage,
  Panel,
} from "@/components/metagraphed/primitives";
import { Ss58Inspector } from "@/components/metagraphed/ss58-inspector";
import { TopHoldersPanel } from "@/components/metagraphed/top-holders-panel";
import { YourPositionsPanel } from "@/components/metagraphed/your-positions-panel";
import { WalletConnectButton } from "@/components/metagraphed/wallet-connect";
import { useWallet } from "@/hooks/use-wallet";
import { AddressDisplay } from "@/components/metagraphed/address-display";
import { taoCompact } from "@/components/metagraphed/neuron-format";
import { isValidH160, isValidSs58, normalizeH160 } from "@/lib/metagraphed/accounts";
import { formatNumber } from "@/lib/metagraphed/format";
import {
  accountsListQuery,
  chainSignersQuery,
  evmAddressMappingQuery,
} from "@/lib/metagraphed/queries";

export function AccountsPage() {
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const trimmed = value.trim();
  // An H160 is a valid thing to paste here too, and rejecting it as "not a
  // valid ss58" would be wrong twice over -- the resolver already told the user
  // this address has a destination.
  const isH160 = isValidH160(trimmed);
  const valid = isValidSs58(trimmed) || isH160;
  const touched = trimmed.length > 0;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    if (isH160) {
      // Through the same ?h160= path a resolver link takes, so there is ONE
      // implementation of "an EVM address becomes an account" rather than two
      // that can disagree.
      navigate({ to: "/accounts", search: { h160: normalizeH160(trimmed) } });
      return;
    }
    navigate({ to: "/accounts/$ss58", params: { ss58: trimmed } });
  };

  return (
    <AppShell>
      <DataPageStage>
        <DataPageHero
          id="accounts-title"
          eyebrow="Account explorer"
          live
          title="Accounts."
          description="Look up a Bittensor account by ss58 address or EVM address — then inspect balances, stake, and first-party chain activity."
          actions={
            <ActionBar>
              <ShareButton bare />
            </ActionBar>
          }
        />
        <DataPageCanvas>
          <DataPageModule
            title="Find an account."
            caption="Paste a hotkey, coldkey, or EVM address to jump directly to the on-chain record."
          >
            <EvmAddressRedirect />
            <form onSubmit={submit} className="w-full max-w-2xl">
              <label htmlFor="ss58" className="mb-2 block mg-type-caption text-ink-muted">
                Account address (ss58 or EVM)
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
                    className="w-full border border-border bg-card py-2.5 pl-10 pr-3 font-mono text-sm text-ink-strong placeholder:text-ink-muted/60 focus:border-ink/30 focus:outline-none min-h-11"
                  />
                </div>
                <button
                  type="submit"
                  disabled={!valid}
                  className="inline-flex min-h-11 items-center justify-center gap-1.5 border border-border bg-card px-4 py-2.5 mg-type-caption font-medium hover:border-ink/30 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Look up
                </button>
              </div>
              <p className="mt-2 mg-type-data text-ink-muted">
                {touched && !valid
                  ? "That doesn't look like a valid ss58 or EVM address."
                  : "Paste a hotkey or coldkey ss58 address — or an EVM (0x) address — to view its activity."}
              </p>
            </form>
          </DataPageModule>

          <DataPageModule
            title="Your wallet."
            caption="Read-only positions for a connected browser wallet; no transaction is constructed or signed here."
          >
            <YourWalletPanel />
          </DataPageModule>

          <DataPageModule
            title="Account leaders."
            caption="Compare the accounts holding the most stake or earning the most emission, then inspect current chain activity."
          >
            <div className="grid gap-6 md:grid-cols-2">
              <AsyncPanel
                context="top accounts by stake"
                fallback={<Skeleton className="h-64 w-full" />}
                retryQueryKeys={[accountsListQuery({ sort: "total_stake" }).queryKey]}
              >
                <AccountsLeaderboard
                  sort="total_stake"
                  title="Top by stake"
                  blurb="Accounts holding the most stake across every subnet."
                  metric={(a) => `${taoCompact(a.total_stake_tao)} τ`}
                />
              </AsyncPanel>
              <AsyncPanel
                context="top accounts by emission"
                fallback={<Skeleton className="h-64 w-full" />}
                retryQueryKeys={[accountsListQuery({ sort: "total_emission" }).queryKey]}
              >
                <AccountsLeaderboard
                  sort="total_emission"
                  title="Top by emission"
                  blurb="Accounts earning the most emission across every subnet."
                  metric={(a) => `${taoCompact(a.total_emission_tao)} τ`}
                />
              </AsyncPanel>
            </div>
            <section className="mt-8" data-testid="top-active-accounts-section">
              <h3 className="mg-type-label text-ink-muted">Most active accounts</h3>
              <p className="mt-1 mb-4 mg-type-data text-ink-muted">
                Ranked by extrinsics signed on-chain in the last {TOP_ACTIVE_ACCOUNTS_WINDOW_DAYS}{" "}
                days — jump straight to an account below.
              </p>
              <AsyncPanel
                context="active accounts"
                fallback={<Skeleton className="h-40 w-full" />}
                retryQueryKeys={[chainSignersQuery().queryKey]}
              >
                <TopActiveAccounts />
              </AsyncPanel>
            </section>
          </DataPageModule>

          <DataPageModule
            title="Inspect an address."
            caption="Decode SS58 prefixes, verify checksums, and compare the current holder leaderboard before you act elsewhere."
          >
            <TopHoldersPanel />
            <div className="mt-8">
              <Ss58Inspector />
            </div>
          </DataPageModule>
        </DataPageCanvas>
        <ApiSourceFooter
          paths={[
            "/api/v1/accounts/{ss58}",
            "/api/v1/accounts",
            "/api/v1/chain/signers",
            "/api/v1/accounts/top-holders",
          ]}
        />
      </DataPageStage>
    </AppShell>
  );
}

function YourWalletPanel() {
  const { wallet } = useWallet();
  return (
    // ph-no-capture: this panel shows the CONNECTED wallet's own address and
    // positions. The retired /portfolio route was replay-blocked wholesale for
    // exactly that reason (see REPLAY_BLOCKED_ROUTES in lib/analytics.ts);
    // /accounts is a public any-address lookup page, so the protection moves
    // to this element rather than blocking the whole route.
    <Panel dense className="ph-no-capture w-full max-w-4xl">
      {wallet ? (
        <AsyncPanel context="your positions" fallback={<Skeleton className="h-64 w-full" />}>
          <YourPositionsPanel address={wallet.address} />
        </AsyncPanel>
      ) : (
        <div className="rounded border border-dashed border-ink-subtle bg-surface/30 p-6 text-center">
          <Wallet className="mx-auto mb-3 size-5 text-ink-muted" aria-hidden />
          <p className="mx-auto mb-4 max-w-md mg-type-caption-lg text-ink-muted">
            Connecting only reads your public on-chain positions from a browser wallet extension.
          </p>
          <div className="flex justify-center">
            <WalletConnectButton />
          </div>
        </div>
      )}
    </Panel>
  );
}

function AccountsLeaderboard({
  sort,
  title,
  blurb,
  metric,
}: {
  sort: string;
  title: string;
  blurb: string;
  metric: (a: { total_stake_tao: number; total_emission_tao: number }) => string;
}) {
  const { data } = useSuspenseQuery(accountsListQuery({ sort, limit: 10 }));
  const rows = data.data.accounts;
  if (rows.length === 0) return null;
  return (
    <Panel dense>
      <h2 className="mb-1 mg-type-label uppercase text-ink-muted">{title}</h2>
      <p className="mb-3 mg-type-data text-ink-muted">{blurb}</p>
      <ol className="divide-y divide-border">
        {rows.map((a, i) => (
          <li key={a.hotkey} className="flex items-center gap-3 py-2 mg-type-data">
            <span className="w-4 shrink-0 text-right tabular-nums text-ink-muted">{i + 1}</span>
            <span className="min-w-0 flex-1">
              <AddressDisplay ss58={a.hotkey} compact fallback="—" />
            </span>
            <span className="shrink-0 tabular-nums text-ink-muted">
              {formatNumber(a.subnet_count)} SN
            </span>
            <span className="shrink-0 tabular-nums font-medium text-ink-strong">{metric(a)}</span>
          </li>
        ))}
      </ol>
      <div className="mt-2 border-t border-border pt-2">
        <Link to="/validators" className="mg-type-data-sm text-ink-muted hover:text-accent">
          Validator directory →
        </Link>
      </div>
    </Panel>
  );
}

/**
 * Turn a `?h160=` into the account it maps to (metagraphed-infra#373).
 *
 * `/api/v1/search/resolve` answers a pasted EVM address with
 * `ui_path: /accounts?h160=0x…` and `exact: true`. Nothing read that parameter,
 * so the one identifier the resolver is CERTAIN about landed on a generic index
 * with the address dropped — the worst outcome of the six shapes it recognises,
 * because it is the one where the user was promised a specific answer.
 *
 * THREE OUTCOMES, and the two that are not a redirect both say something true:
 *
 *   * mapped     -> replace into /accounts/{ss58}. `replace`, not push, so Back
 *                   returns to wherever the link was clicked rather than
 *                   bouncing through this page again.
 *   * unmapped   -> "no account" is a REAL answer from the chain, not an error.
 *                   `AddressMapping.addressMapping` simply has no entry, which
 *                   is the normal state for an address that has never been used
 *                   on this chain.
 *   * unreadable -> say so, and leave the lookup form usable underneath.
 */
function EvmAddressRedirect() {
  const navigate = useNavigate();
  const { h160 } = useSearch({ from: "/accounts/" });
  const address = h160 && isValidH160(h160) ? normalizeH160(h160) : "";
  const mapping = useQuery({ ...evmAddressMappingQuery(address), retry: 0 });
  const ss58 = mapping.data?.data.ss58 ?? null;

  useEffect(() => {
    if (!ss58) return;
    navigate({ to: "/accounts/$ss58", params: { ss58 }, replace: true });
  }, [ss58, navigate]);

  if (!h160) return null;
  return (
    <Panel className="mx-auto mb-6 w-full max-w-2xl">
      <p className="mg-type-caption text-ink-muted">EVM address</p>
      <p className="mt-1 break-all font-mono text-sm text-ink-strong">{h160}</p>
      <p className="mt-2 mg-type-data text-ink-muted">
        {!address
          ? "That is not a well-formed EVM address (expected 0x followed by 40 hex characters)."
          : mapping.isPending
            ? "Looking up the account this address maps to…"
            : mapping.isError
              ? "Could not read the EVM address mapping just now."
              : ss58
                ? "Found it — taking you there."
                : "This EVM address is not mapped to a Bittensor account on-chain."}
      </p>
    </Panel>
  );
}
