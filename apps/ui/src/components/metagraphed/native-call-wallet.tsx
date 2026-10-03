import { useEffect, useRef, useState } from "react";
import type { ApiPromise } from "@polkadot/api";
import { WalletConnectPanel } from "./wallet-connect";
import { useWallet } from "@/hooks/use-wallet";
import { useTxStatus } from "@/hooks/use-tx-status";
import { getApi, rpcEndpointForNetwork } from "@/lib/metagraphed/chain-connection";
import { getApiBase, getNetwork } from "@/lib/metagraphed/config";
import { getConnectedWallet } from "@/lib/metagraphed/wallet";
import { getSigner } from "@/lib/metagraphed/wallet-injected";
import { computeIdempotencyKey } from "@/lib/metagraphed/broadcast";
import {
  guardNativeSigner,
  previewNativeCall,
  revalidateNativeCall,
  type NativeCallPreview,
} from "@/lib/metagraphed/native-call-wallet";
import type { NativeArtifact } from "@/lib/metagraphed/native-runtime";
import { basketTao } from "@/lib/metagraphed/root-baskets";

const button =
  "rounded border border-border bg-card px-3 py-2 text-13 font-medium text-ink-strong hover:border-ink/30 disabled:opacity-50";
function context() {
  const wallet = getConnectedWallet();
  return `${getApiBase()}:${getNetwork().id}:${wallet?.address}:${wallet?.source}`;
}

/** Explicit review and signing; every asynchronous continuation checks the
 * mounted account/network/origin before it can request a wallet signature. */
export function NativeCallWallet({ artifact, index }: { artifact: NativeArtifact; index: number }) {
  const wallet = useWallet();
  const transaction = useTxStatus();
  const [review, setReview] = useState<{
    api: ApiPromise;
    preview: NativeCallPreview;
    context: string;
    session: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  const working = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    setReview(null);
  }, [wallet.wallet?.address, wallet.wallet?.source, wallet.status]);
  const inFlight =
    busy ||
    ["signing", "future", "ready", "broadcast", "in-block", "retracted"].includes(
      transaction.status,
    );
  const assertContext = (expected: string) => {
    if (!active.current || context() !== expected)
      throw new Error("The account, network or API changed. Review this call again.");
  };
  const prepare = async () => {
    if (working.current || !wallet.wallet) return;
    const expected = context(),
      address = wallet.wallet.address;
    working.current = true;
    setBusy(true);
    setError(null);
    setReview(null);
    transaction.reset();
    try {
      const api = await getApi(rpcEndpointForNetwork(getNetwork().id));
      assertContext(expected);
      const preview = await previewNativeCall(api, artifact, index, address);
      assertContext(expected);
      setReview({ api, preview, context: expected, session: crypto.randomUUID() });
    } catch (failure) {
      if (active.current)
        setError(failure instanceof Error ? failure.message : "The call could not be reviewed.");
    } finally {
      working.current = false;
      if (active.current) setBusy(false);
    }
  };
  const sign = async () => {
    if (working.current || !review || !wallet.wallet) return;
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      assertContext(review.context);
      const connectedSigner = await getSigner(wallet.wallet.source);
      assertContext(review.context);
      await revalidateNativeCall(review.api, review.preview);
      assertContext(review.context);
      const { preview } = review;
      const signer = guardNativeSigner(
        connectedSigner,
        preview,
        () => assertContext(review.context),
        () => revalidateNativeCall(review.api, preview),
      );
      await transaction.submit(review.api, preview.extrinsic, {
        signerAddress: preview.address,
        signer,
        nonce: preview.nonce,
        idempotencyKey: computeIdempotencyKey(
          {
            callData: preview.callData,
            address: preview.address,
            genesisHash: preview.source.network_genesis_hash,
          },
          preview.nonce,
          review.session,
        ),
      });
    } catch (failure) {
      if (active.current)
        setError(failure instanceof Error ? failure.message : "The call could not be submitted.");
    } finally {
      working.current = false;
      if (active.current) setBusy(false);
    }
  };
  return (
    <section
      aria-label="Native wallet review"
      className="min-w-0 space-y-3 rounded border border-border p-4"
    >
      <h3 className="font-display text-16 text-ink-strong">Review and sign with your wallet</h3>
      {wallet.status !== "connected" ? (
        <WalletConnectPanel />
      ) : (
        <>
          <p className="break-all text-13 text-ink-muted">
            Signing account: {wallet.wallet?.address}
          </p>
          <button className={button} disabled={inFlight} onClick={() => void prepare()}>
            Review call and fee
          </button>
        </>
      )}
      {busy && (
        <p role="status" className="text-13 text-ink-muted">
          Checking the wallet and current runtime…
        </p>
      )}
      {review && (
        <>
          <dl className="grid min-w-0 gap-3 text-13 sm:grid-cols-2">
            <div>
              <dt className="text-ink-muted">Call</dt>
              <dd>
                {review.preview.pallet}.{review.preview.member}
              </dd>
            </div>
            <div>
              <dt className="text-ink-muted">Network and runtime</dt>
              <dd>
                {review.preview.source.network} · v{review.preview.source.runtime_spec_version}
              </dd>
            </div>
            <div>
              <dt className="text-ink-muted">Estimated fee</dt>
              <dd>{basketTao(review.preview.feeRao.toString())}</dd>
            </div>
            <div>
              <dt className="text-ink-muted">Reviewed fee allowance</dt>
              <dd>{basketTao(review.preview.maxFeeRao.toString())}</dd>
            </div>
            <div>
              <dt className="text-ink-muted">Spendable balance</dt>
              <dd>{basketTao(review.preview.balanceRao.toString())}</dd>
            </div>
            <div>
              <dt className="text-ink-muted">Pending nonce</dt>
              <dd>{review.preview.nonce}</dd>
            </div>
          </dl>
          <dl className="min-w-0 space-y-2 text-13">
            {review.preview.arguments.map((arg, position) => (
              <div key={position}>
                <dt className="text-ink-muted">{arg.name}</dt>
                <dd className="break-all font-mono">{arg.value}</dd>
              </div>
            ))}
          </dl>
          <details>
            <summary className="cursor-pointer text-13 text-ink-muted">Exact method bytes</summary>
            <p className="break-all font-mono text-12">{review.preview.callData}</p>
          </details>
          <p className="text-13 text-ink-muted">
            Review every argument in your wallet. Signing submits this call to the chain. The fee
            recheck allows a 10% increase in the estimate; it does not cap the final chain fee or
            predict the total transferred value.
          </p>
          <button
            className={button}
            disabled={inFlight || transaction.status !== "idle"}
            onClick={() => void sign()}
          >
            Sign and submit reviewed call
          </button>
        </>
      )}
      {error && (
        <p role="alert" className="text-13 text-health-down">
          {error}
        </p>
      )}
      {transaction.status !== "idle" && (
        <div aria-live="polite" className="min-w-0 space-y-2 text-13">
          <p>Transaction: {transaction.status}</p>
          {transaction.error && (
            <p role="alert" className="text-health-down">
              {transaction.error.message}
            </p>
          )}
          {transaction.txHash && (
            <p className="break-all font-mono">Transaction hash: {transaction.txHash}</p>
          )}
          {transaction.blockHash && (
            <p className="break-all font-mono">Block hash: {transaction.blockHash}</p>
          )}
        </div>
      )}
    </section>
  );
}
