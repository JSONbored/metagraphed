import { Link } from "@tanstack/react-router";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ExternalLink } from "@jsonbored/ui-kit";
import { PageMasthead, Panel } from "@/components/metagraphed/primitives";
import { API_BASE, GITHUB_REPO } from "@/lib/metagraphed/config";

export function TermsPage() {
  return (
    <AppShell>
      <PageMasthead
        eyebrow="Terms"
        title="Terms of use"
        description="What you can rely on from Metagraphed, what you cannot, and the few things we ask in return."
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-8 min-w-0">
          <Section title="What this service is">
            <p>
              Metagraphed is an independent, unofficial explorer and integration registry for
              Bittensor. It is not an OpenTensor or Bittensor Foundation product, and nothing here
              is endorsed by them.
            </p>
            <p>
              The REST API, GraphQL endpoint, and MCP server are public and read-only. Most of the
              surface needs no account.
            </p>
          </Section>

          <Section title="Accuracy, and what you should not rely on">
            <p>
              Data is provided <strong>as is</strong>. We read the chain, probe public endpoints,
              and publish what we observe, with freshness and provenance attached wherever we can.
              That is a best effort, not a guarantee: a reading can be stale, an endpoint can be
              misconfigured, and a derived figure can be wrong.
            </p>
            <p>
              Nothing here is financial advice. Economic figures — emissions, yields, prices, stake
              previews — are informational, frequently approximate, and must not be the sole basis
              for a financial decision. Verify against the chain before acting on anything that
              moves money.
            </p>
            <p>We make no uptime guarantee and offer no SLA on the free tier.</p>
          </Section>

          <Section title="Fair use">
            <p>Please:</p>
            <ul className="list-disc pl-6 space-y-1.5">
              <li>
                Stay within the published rate limits — see{" "}
                <ExternalLink href={`${API_BASE}/auth.md`}>auth.md</ExternalLink>. Authenticating
                raises them.
              </li>
              <li>
                Send a User-Agent that identifies your client, so we can tell a problem with your
                integration from a problem with ours.
              </li>
              <li>
                Cache what you can. Most artifacts are edge-cached and carry validators; honouring
                them costs you nothing and costs us less.
              </li>
              <li>
                Do not attempt to bypass rate limits, quotas, or access controls, including by
                rotating identities to evade them.
              </li>
            </ul>
            <p>
              We may throttle or block an account or client that makes the service worse for
              everyone else. Where we do, the response says so with a reason code rather than
              failing silently.
            </p>
          </Section>

          <Section title="Calling subnet APIs through us">
            <p>
              The registry can call a catalogued subnet&rsquo;s own API on your behalf. When it
              does, you are using <em>their</em> service, under <em>their</em> terms, with{" "}
              <em>your</em> credential. We do not obtain credentials for you, we grant no authority
              you did not already have calling that API directly, and we are not responsible for
              what a third-party surface does with a request you asked us to forward.
            </p>
          </Section>

          <Section title="Non-custodial by design">
            <p>
              We never hold your keys, seed phrases, or funds. Any signing happens in your own
              wallet, locally. We cannot move your assets, and we cannot recover them.
            </p>
          </Section>

          <Section title="Using the data">
            <p>
              Chain data is public information. Our derived artifacts, schemas, and registry records
              are published so they can be used — build on them. If you redistribute them at scale,
              attribution is appreciated and a link back helps people find the source of a figure
              they want to check.
            </p>
            <p>
              The code is open source; see the{" "}
              <ExternalLink href={GITHUB_REPO}>repository</ExternalLink> for its licence, which
              governs the code rather than this service.
            </p>
          </Section>

          <Section title="Liability">
            <p>
              To the fullest extent permitted by law, Metagraphed is provided without warranty of
              any kind, and we are not liable for any loss arising from use of, or inability to use,
              this service or its data — including trading losses, missed opportunities, or
              downstream failures in systems that depend on it.
            </p>
          </Section>

          <Section title="Changes">
            <p>
              These terms live in the same repository as the code, so any change is visible in the
              commit history. Continuing to use the service after a change means accepting it.
            </p>
          </Section>

          <Section title="Contact">
            <p>
              Questions or disputes:{" "}
              <ExternalLink href="https://github.com/JSONbored/metagraphed/issues">
                open an issue
              </ExternalLink>
              . For security reports, see{" "}
              <ExternalLink href={`${API_BASE}/.well-known/security.txt`}>
                security.txt
              </ExternalLink>
              .
            </p>
          </Section>
        </div>
        <aside className="space-y-6">
          <Panel title="Also relevant">
            <div className="grid gap-1.5">
              <Link
                to="/privacy"
                className="text-11 text-ink-muted hover:text-ink-strong inline-flex items-center gap-1"
              >
                → Privacy policy
              </Link>
              <ExternalLink
                href={`${API_BASE}/auth.md`}
                className="text-11 text-ink-muted hover:text-ink-strong inline-flex items-center gap-1"
              >
                → auth.md — rate limits &amp; auth
              </ExternalLink>
              <Link
                to="/about"
                className="text-11 text-ink-muted hover:text-ink-strong inline-flex items-center gap-1"
              >
                → Methodology &amp; scope
              </Link>
            </div>
          </Panel>
        </aside>
      </div>
    </AppShell>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="font-display text-13 font-semibold text-ink-strong mb-2">{title}</h2>
      <div className="text-13 leading-relaxed text-ink space-y-2">{children}</div>
    </section>
  );
}
