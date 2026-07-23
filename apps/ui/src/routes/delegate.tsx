import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowUpRight, Sparkles, ShieldCheck, Clock } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { PARTNER_ORG, PARTNER_VALIDATORS } from "@/lib/metagraphed/partners";

export const Route = createFileRoute("/delegate")({
  head: () => ({
    meta: [
      { title: "Delegate τ to Ventura Labs · Metagraphed" },
      {
        name: "description",
        content:
          "One-click delegate or redelegate τ to featured partner validators across supported Bittensor subnets.",
      },
    ],
  }),
  component: DelegatePage,
});

function DelegatePage() {
  return (
    <AppShell>
      {/* Hero */}
      <section className="mg-hero-slab relative pt-12 pb-8 md:pt-16 md:pb-10">
        <div className="max-w-3xl">
          <div className="mg-fade-in font-mono text-[10px] uppercase tracking-[0.22em] text-ink-muted inline-flex items-center gap-2">
            <span className="mg-live-dot" />
            Partner validators · {PARTNER_ORG.name}
          </div>
          <h1 className="mg-fade-in mg-fade-in-delay-1 mt-4 font-display text-4xl md:text-5xl font-semibold leading-[1.05] tracking-tight text-ink-strong">
            Delegate τ to <span className="text-accent">Ventura Labs</span>.
          </h1>
          <p className="mg-fade-in mg-fade-in-delay-2 mt-5 max-w-2xl text-base text-ink-muted leading-relaxed">
            {PARTNER_ORG.tagline} Pick a subnet below to stake τ, or redelegate from your current
            validator. All flows sign in your own wallet — Metagraphed never custodies keys.
          </p>
        </div>

        {/* Trust strip */}
        <div className="mg-fade-in mg-fade-in-delay-3 mt-8 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <TrustCell
            icon={<ShieldCheck className="size-4" />}
            title="Non-custodial"
            body="You sign every extrinsic in your own wallet (Polkadot.js / Talisman)."
          />
          <TrustCell
            icon={<Sparkles className="size-4" />}
            title="Adapter-backed"
            body="APY and take are read live from public adapters — no marketing numbers."
          />
          <TrustCell
            icon={<Clock className="size-4" />}
            title="Redelegate anytime"
            body="Move stake to or from any validator on the same subnet without unstaking."
          />
        </div>
      </section>

      {/* Validators grid */}
      <section className="mt-10">
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="font-display text-xl font-semibold text-ink-strong">Supported subnets</h2>
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
            {PARTNER_VALIDATORS.length} live · more rolling out
          </span>
        </div>

        <ul className="grid gap-3 md:grid-cols-2">
          {PARTNER_VALIDATORS.map((p) => (
            <li key={p.netuid}>
              <Link
                to={p.live ? "/validators/$hotkey" : "/subnets/$netuid"}
                params={p.live ? { hotkey: p.hotkey } : { netuid: p.netuid }}
                className="mg-metric-tile group flex h-full flex-col rounded-xl border border-border bg-card p-5 transition-colors hover:border-accent/60"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
                      SN{p.netuid} · {p.subnetName}
                    </div>
                    <div className="mt-1 font-display text-lg font-semibold text-ink-strong">
                      {p.label}
                    </div>
                  </div>
                  <span
                    className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest ${
                      p.live ? "border-health-ok/40 text-health-ok" : "border-border text-ink-muted"
                    }`}
                  >
                    {p.live ? "Live" : "Coming soon"}
                  </span>
                </div>
                <p className="mt-3 text-[13px] text-ink-muted leading-relaxed">{p.blurb}</p>
                <div className="mt-4 inline-flex items-center gap-1.5 self-start rounded-full border border-accent/50 bg-primary-soft/50 px-3 py-1.5 text-[12px] font-medium text-ink-strong transition-colors group-hover:border-accent">
                  {p.live ? "Stake / redelegate" : "Open subnet"}
                  <ArrowUpRight className="size-3" />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {/* Disclosure */}
      <section className="mt-10 rounded-xl border border-border bg-card/60 p-5">
        <div className="mg-label mb-2">Disclosure</div>
        <p className="text-[13px] text-ink-muted leading-relaxed">{PARTNER_ORG.disclosure}</p>
      </section>
    </AppShell>
  );
}

function TrustCell({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="rounded-lg border border-border bg-card/60 px-4 py-3">
      <div className="flex items-center gap-2 text-ink-strong">
        <span className="text-accent" aria-hidden>
          {icon}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.18em]">{title}</span>
      </div>
      <p className="mt-1.5 text-[12px] text-ink-muted leading-relaxed">{body}</p>
    </div>
  );
}
