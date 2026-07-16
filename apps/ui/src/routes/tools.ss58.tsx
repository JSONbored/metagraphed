import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { CopyableCode, PageHero } from "@jsonbored/ui-kit";
import { decodeSs58, DEFAULT_SS58_FORMAT } from "@/lib/metagraphed/ss58";
import { classNames } from "@/lib/metagraphed/format";

export const Route = createFileRoute("/tools/ss58")({
  head: () => ({
    meta: [
      { title: "SS58 address inspector — Metagraphed" },
      {
        name: "description",
        content:
          "Decode and validate any SS58-formatted Substrate address — network prefix, public key, checksum. Runs entirely in your browser; nothing is sent anywhere. No API key.",
      },
    ],
  }),
  component: Ss58ToolPage,
});

// The handful of prefixes a Bittensor user could plausibly paste in by
// mistake -- not a full registry of the ~60 assigned SS58 prefixes, which
// would be scope well beyond a quick sanity-check tool.
const KNOWN_FORMATS: Record<number, string> = {
  0: "Polkadot",
  2: "Kusama",
  [DEFAULT_SS58_FORMAT]: "Generic Substrate (Bittensor)",
};

function toHex(bytes: Uint8Array): string {
  return "0x" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function Ss58ToolPage() {
  const [input, setInput] = useState("");
  const trimmed = input.trim();
  const decoded = useMemo(() => (trimmed ? decodeSs58(trimmed) : null), [trimmed]);

  return (
    <AppShell>
      <PageHero
        eyebrow="Tools"
        title="SS58 address inspector"
        description="Paste any SS58-formatted Substrate address to decode its network prefix and public key, and verify its checksum. Runs entirely in your browser — nothing here is ever sent anywhere."
        caption="tools / ss58"
      />

      <div className="space-y-6">
        <div>
          <label htmlFor="ss58-input" className="mg-label mb-2 block">
            Address
          </label>
          <input
            id="ss58-input"
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"
            spellCheck={false}
            autoComplete="off"
            className="w-full rounded-lg border border-border bg-card px-4 py-3 font-mono text-sm text-ink-strong placeholder:text-ink-muted/50 focus:border-accent/50 focus:outline-none"
          />
        </div>

        {trimmed && decoded === null ? (
          <ResultCard tone="error" icon={XCircle} title="Not a valid SS58 address">
            <p>
              Couldn&apos;t decode this as SS58 — either the base58 encoding is malformed, or the
              decoded length doesn&apos;t match a standard 32-byte account (prefix + public key +
              2-byte checksum).
            </p>
          </ResultCard>
        ) : null}

        {decoded?.extendedFormat ? (
          <ResultCard tone="warn" icon={AlertTriangle} title="Extended (2-byte) network prefix">
            <p>
              This address uses a prefix in the 64-127 range, which SS58 encodes across 2 bytes with
              a bit-packed scheme this tool doesn&apos;t decode — every network a Bittensor user
              would realistically encounter (Polkadot, Kusama, generic Substrate) uses a simple
              single-byte prefix instead, so this is either a wallet's byte encoding quirk or a much
              less common chain.
            </p>
          </ResultCard>
        ) : null}

        {decoded && !decoded.extendedFormat && !decoded.checksumValid ? (
          <ResultCard tone="error" icon={XCircle} title="Invalid checksum">
            <p>
              The address parses to the right shape (prefix + 32-byte account + checksum), but the
              checksum doesn&apos;t match — this address has been mistyped, truncated, or corrupted
              somewhere. Double-check every character before using it.
            </p>
          </ResultCard>
        ) : null}

        {decoded?.valid && decoded.pubkey ? (
          <ResultCard
            tone="ok"
            icon={CheckCircle2}
            title={
              decoded.format === DEFAULT_SS58_FORMAT
                ? "Valid Bittensor address"
                : "Valid SS58 address — not Bittensor"
            }
          >
            <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2.5 text-sm">
              <dt className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                Network prefix
              </dt>
              <dd className="font-mono text-ink-strong">
                {decoded.format}
                {KNOWN_FORMATS[decoded.format] ? (
                  <span className="ml-2 text-ink-muted">({KNOWN_FORMATS[decoded.format]})</span>
                ) : null}
              </dd>
              <dt className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                Public key
              </dt>
              <dd className="min-w-0">
                <CopyableCode value={toHex(decoded.pubkey)} className="w-full" />
              </dd>
              <dt className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                Checksum
              </dt>
              <dd className="text-health-ok">Valid</dd>
            </dl>
            {decoded.format !== DEFAULT_SS58_FORMAT ? (
              <p className="mt-3 text-[13px] text-ink-muted">
                This is a well-formed SS58 address, but its network prefix ({decoded.format}) is not
                Bittensor&apos;s ({DEFAULT_SS58_FORMAT}) — it belongs to
                {KNOWN_FORMATS[decoded.format]
                  ? ` ${KNOWN_FORMATS[decoded.format]}`
                  : " a different Substrate chain"}
                . Sending TAO to it would go to a different key on a different network, not this
                account on Bittensor.
              </p>
            ) : null}
          </ResultCard>
        ) : null}

        <section className="rounded-lg border border-border bg-card p-5 text-[13px] leading-relaxed text-ink-muted">
          <h2 className="mb-2 font-display text-sm font-semibold text-ink-strong">
            How this works
          </h2>
          <p>
            An SS58 address is{" "}
            <code className="font-mono text-ink-strong">
              base58(prefix || public_key || checksum)
            </code>{" "}
            — a network-prefix byte, the 32-byte sr25519/ed25519 public key, and a 2-byte checksum
            (the first 2 bytes of a blake2b-512 hash over{" "}
            <code className="font-mono text-ink-strong">"SS58PRE" || prefix || public_key</code>),
            all base58-encoded. The same public key produces a different address string per network
            — Bittensor's hotkeys and coldkeys use prefix 42 (&quot;generic Substrate&quot;), the
            same prefix several other chains without a dedicated allocation also use. Decoding and
            checksum verification happen entirely client-side; this page makes no network requests.
          </p>
        </section>
      </div>
    </AppShell>
  );
}

function ResultCard({
  tone,
  icon: Icon,
  title,
  children,
}: {
  tone: "ok" | "warn" | "error";
  icon: typeof CheckCircle2;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={classNames(
        "rounded-lg border p-5",
        tone === "ok" && "border-health-ok/30 bg-health-ok/5",
        tone === "warn" && "border-health-warn/30 bg-health-warn/5",
        tone === "error" && "border-health-down/30 bg-health-down/5",
      )}
    >
      <div className="flex items-center gap-2">
        <Icon
          className={classNames(
            "size-4 shrink-0",
            tone === "ok" && "text-health-ok",
            tone === "warn" && "text-health-warn",
            tone === "error" && "text-health-down",
          )}
          aria-hidden
        />
        <h2 className="font-display text-sm font-semibold text-ink-strong">{title}</h2>
      </div>
      <div className="mt-2.5 text-[13px] leading-relaxed text-ink-muted">{children}</div>
    </div>
  );
}
