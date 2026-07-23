import { createFileRoute } from "@tanstack/react-router";
import { Suspense } from "react";
import { Wallet } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { Skeleton } from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { PageMasthead } from "@/components/metagraphed/primitives";
import { useWallet } from "@/hooks/use-wallet";
import { WalletConnectButton } from "@/components/metagraphed/wallet-connect";
import { YourPositionsPanel } from "@/components/metagraphed/your-positions-panel";

export const Route = createFileRoute("/portfolio")({
  head: () => ({
    meta: [
      { title: "Your positions — Metagraphed" },
      {
        name: "description",
        content:
          "Your Bittensor staking positions across every subnet for the connected wallet — hotkey-owned and delegated, valued at spot and at a slippage-aware simulated exit.",
      },
      { property: "og:title", content: "Your positions — Metagraphed" },
      {
        property: "og:description",
        content:
          "Cross-subnet staking positions for the connected wallet — spot vs. simulated-exit value, root/alpha split, and yield.",
      },
    ],
  }),
  component: PortfolioPage,
});

// #5243: the read-side payoff of the staking epic (#5229) — the portfolio view
// for a connected wallet. Read-only: it links into the unstake/move-stake modals
// but never constructs a transaction itself. Wallet state is client-only, so the
// whole page is gated behind a connected wallet rather than a route param.
function PortfolioPage() {
  const { wallet } = useWallet();

  return (
    <AppShell>
      <PageMasthead
        eyebrow="Wallet"
        live
        title="Your positions"
        description="Your staking positions across every subnet for the connected wallet — hotkey-owned and delegated — valued two ways: a spot mark and a slippage-aware simulated exit."
      />

      {wallet ? (
        <QueryErrorBoundary>
          <Suspense fallback={<Skeleton className="h-96 w-full" />}>
            <YourPositionsPanel address={wallet.address} />
          </Suspense>
        </QueryErrorBoundary>
      ) : (
        <div className="rounded border border-dashed border-ink-subtle bg-surface/30 p-8 text-center">
          <Wallet className="mx-auto mb-3 size-6 text-ink-muted" aria-hidden />
          <h2 className="text-sm font-medium text-ink-strong">
            Connect a wallet to see your positions
          </h2>
          <p className="mx-auto mt-1 mb-4 max-w-md text-[13px] text-ink-muted">
            This app is read-only — it never constructs or signs a transaction. Connecting only
            reads your public on-chain positions from a browser wallet extension.
          </p>
          <div className="flex justify-center">
            <WalletConnectButton />
          </div>
        </div>
      )}

      <ApiSourceFooter
        paths={[
          "/api/v1/accounts/{ss58}/portfolio",
          "/api/v1/accounts/{ss58}/positions",
          "/api/v1/subnets/{netuid}/stake-quote",
        ]}
      />
    </AppShell>
  );
}
