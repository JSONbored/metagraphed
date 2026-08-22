import { Link } from "@tanstack/react-router";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ExternalLink, EntityHero, FactSentence } from "@jsonbored/ui-kit";
import { Panel } from "@/components/metagraphed/primitives";
import { API_BASE } from "@/lib/metagraphed/config";

/**
 * The numbers below are the ones the server actually enforces
 * (`src/mcp-surface-credentials.ts`). `apps/ui` cannot import them — they are
 * not part of the published client package, and widening that package's public
 * surface for a prose page would be the wrong trade — so a root-level test
 * reads this file and asserts they still match the constants.
 */
const CREDENTIAL_DEFAULT_TTL_DAYS = 30;
const CREDENTIAL_MAX_TTL_DAYS = 90;

export function PrivacyPage() {
  return (
    <AppShell>
      <EntityHero
        name="Privacy policy"
        sentence={
          <FactSentence>
            What Metagraphed collects, why, how long it is kept, and who else processes it. Written
            to be checkable against the code rather than to be reassuring.
          </FactSentence>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-8 min-w-0">
          <Section title="The short version">
            <p>
              The API and MCP server are public and read-only. You can use nearly all of it without
              an account, and without telling us who you are. We do not sell data, we do not run
              advertising, and we do not build profiles of individuals.
            </p>
            <p>
              What we do keep is operational: enough to run the service, bill the accounts that have
              one, and know which parts of it are actually used.
            </p>
          </Section>

          <Section title="Requests to the API and MCP server">
            <p>Every request is logged for operational purposes. That record includes:</p>
            <ul className="list-disc pl-6 space-y-1.5">
              <li>The route or tool called, response status, and timing.</li>
              <li>
                A <strong>salted SHA-256 hash of your IP address</strong> — never the address
                itself. It exists so &ldquo;how many distinct callers&rdquo; is answerable without
                identifying any of them.
              </li>
              <li>
                Your client&rsquo;s self-reported name and version, from the User-Agent or the MCP
                handshake.
              </li>
              <li>
                For MCP tool calls, the tool name and arguments, and{" "}
                <strong>any free-text context your agent chose to send</strong> describing why it
                was calling. That text is written by your agent, not by us — if it puts something
                sensitive there, we receive it.
              </li>
            </ul>
            <p>
              Cloudflare, which serves every request, keeps its own edge logs independently of this.
            </p>
          </Section>

          <Section title="If you sign in">
            <p>
              Signing in with GitHub stores your GitHub user ID, your login, and a tier. We ask
              GitHub only for <code>read:user</code> — we never see your password, your email is not
              requested, and we cannot act on your GitHub account. You are shown which client is
              asking before the flow begins, and you can revoke the grant at any time.
            </p>
            <p>
              Accounts with an API key also accumulate per-day request and quota counters, which is
              what a usage dashboard and any bill are computed from.
            </p>
          </Section>

          <Section title="The credential store">
            <p>
              If you register a credential for a third-party subnet API, it is encrypted with{" "}
              <strong>AES-256-GCM</strong> before storage and is readable only by your own account.
              It is sent to the subnet surface you registered it against and to nowhere else.
            </p>
            <p>
              Stored credentials <strong>expire automatically</strong>: after{" "}
              {CREDENTIAL_DEFAULT_TTL_DAYS} days by default, and at most {CREDENTIAL_MAX_TTL_DAYS}{" "}
              days if you ask for longer. You can delete one at any time. The store exists so
              secrets stop travelling through tool arguments, client logs, and conversation
              transcripts.
            </p>
          </Section>

          <Section title="What we do not collect">
            <ul className="list-disc pl-6 space-y-1.5">
              <li>Raw IP addresses in our own analytics.</li>
              <li>Advertising, cross-site, or third-party tracking identifiers.</li>
              <li>
                Private keys, seed phrases, or wallet secrets. Wallet signing is non-custodial and
                happens in your own wallet — never on our servers.
              </li>
              <li>Payment card details. We do not process card payments.</li>
            </ul>
          </Section>

          <Section title="Retention">
            <ul className="list-disc pl-6 space-y-1.5">
              <li>
                <strong>Product analytics</strong> are retained by PostHog under its own retention
                policy.
              </li>
              <li>
                <strong>Stored credentials</strong> expire on the schedule above, enforced by the
                storage layer rather than by a cleanup job.
              </li>
              <li>
                <strong>Account records and usage counters</strong> are kept while the account
                exists.
              </li>
              <li>
                <strong>Chain data</strong> — blocks, extrinsics, balances — is public information
                read from the Bittensor network. It is not personal data we collected, and we cannot
                delete it from the chain.
              </li>
            </ul>
          </Section>

          <Section title="Who else processes it">
            <p>
              We use a small number of infrastructure providers, each processing data only to
              deliver the service:
            </p>
            <ul className="list-disc pl-6 space-y-1.5">
              <li>
                <strong>Cloudflare</strong> — serving, edge caching, storage, and DDoS protection.
              </li>
              <li>
                <strong>Neon</strong> — the Postgres database behind accounts and indexed chain
                data.
              </li>
              <li>
                <strong>PostHog</strong> — product analytics and error tracking.
              </li>
              <li>
                <strong>Unkey</strong> — API key issuance and verification.
              </li>
              <li>
                <strong>GitHub</strong> — sign-in, when you choose to use it.
              </li>
            </ul>
          </Section>

          <Section title="Your choices">
            <ul className="list-disc pl-6 space-y-1.5">
              <li>Use the API and MCP server anonymously — most of it needs no account at all.</li>
              <li>
                Omit the optional context argument on MCP tool calls if you would rather not send
                it.
              </li>
              <li>Delete a stored credential, or let it expire.</li>
              <li>Ask us to delete your account and its records, using the contact below.</li>
            </ul>
          </Section>

          <Section title="Changes">
            <p>
              This policy is versioned in the same repository as the code it describes, so any
              change to it is visible in the commit history alongside the change that prompted it.
            </p>
          </Section>

          <Section title="Contact">
            <p>
              Questions, corrections, or a deletion request:{" "}
              <ExternalLink href="https://github.com/JSONbored/metagraphed/issues">
                open an issue
              </ExternalLink>
              , or see{" "}
              <ExternalLink href={`${API_BASE}/.well-known/security.txt`}>
                security.txt
              </ExternalLink>{" "}
              for a security contact.
            </p>
          </Section>
        </div>
        <aside className="space-y-6">
          <Panel title="Also relevant">
            <div className="grid gap-1.5">
              <Link
                to="/terms"
                className="text-11 text-ink-muted hover:text-ink-strong inline-flex items-center gap-1"
              >
                → Terms of use
              </Link>
              <ExternalLink
                href={`${API_BASE}/auth.md`}
                className="text-11 text-ink-muted hover:text-ink-strong inline-flex items-center gap-1"
              >
                → auth.md — what authenticating changes
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
