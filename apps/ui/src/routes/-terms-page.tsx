import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ExternalLink, EntityHero, FactSentence, SectionNav } from "@jsonbored/ui-kit";
import { ProseSection } from "@/components/metagraphed/prose/prose-doc";
import {
  TERMS_SECTIONS,
  proseNavItems,
  type TermsSection,
} from "@/components/metagraphed/prose/prose-doc-logic";
import { API_BASE, GITHUB_REPO } from "@/lib/metagraphed/config";

const NAV = proseNavItems(TERMS_SECTIONS);

const BODIES: Record<TermsSection, ReactNode> = {
  "What this service is": (
    <>
      <p>
        Metagraphed is an independent, unofficial explorer and integration registry for Bittensor.
        It is not an OpenTensor or Bittensor Foundation product, and nothing here is endorsed by
        them.
      </p>
      <p>
        The REST API, GraphQL endpoint, and MCP server are public and read-only. Most of the surface
        needs no account.
      </p>
    </>
  ),
  "Accuracy, and what you should not rely on": (
    <>
      <p>
        Data is provided <strong>as is</strong>. We read the chain, probe public endpoints, and
        publish what we observe, with freshness and provenance attached wherever we can. That is a
        best effort, not a guarantee: a reading can be stale, an endpoint can be misconfigured, and
        a derived figure can be wrong.
      </p>
      <p>
        Nothing here is financial advice. Economic figures — emissions, yields, prices, stake
        previews — are informational, frequently approximate, and must not be the sole basis for a
        financial decision. Verify against the chain before acting on anything that moves money.
      </p>
      <p>We make no uptime guarantee and offer no SLA on the free tier.</p>
    </>
  ),
  "Fair use": (
    <>
      <p>Please:</p>
      <ul>
        <li>
          Stay within the published rate limits — see{" "}
          <ExternalLink href={`${API_BASE}/auth.md`}>auth.md</ExternalLink>. Authenticating raises
          them.
        </li>
        <li>
          Send a User-Agent that identifies your client, so we can tell a problem with your
          integration from a problem with ours.
        </li>
        <li>
          Cache what you can. Most artifacts are edge-cached and carry validators; honouring them
          costs you nothing and costs us less.
        </li>
        <li>
          Do not attempt to bypass rate limits, quotas, or access controls, including by rotating
          identities to evade them.
        </li>
      </ul>
      <p>
        We may throttle or block an account or client that makes the service worse for everyone
        else. Where we do, the response says so with a reason code rather than failing silently.
      </p>
    </>
  ),
  "Calling subnet APIs through us": (
    <>
      <p>
        The registry can call a catalogued subnet&rsquo;s own API on your behalf. When it does, you
        are using <em>their</em> service, under <em>their</em> terms, with <em>your</em> credential.
        We do not obtain credentials for you, we grant no authority you did not already have calling
        that API directly, and we are not responsible for what a third-party surface does with a
        request you asked us to forward.
      </p>
    </>
  ),
  "Non-custodial by design": (
    <>
      <p>
        We never hold your keys, seed phrases, or funds. Any signing happens in your own wallet,
        locally. We cannot move your assets, and we cannot recover them.
      </p>
    </>
  ),
  "Using the data": (
    <>
      <p>
        Chain data is public information. Our derived artifacts, schemas, and registry records are
        published so they can be used — build on them. If you redistribute them at scale,
        attribution is appreciated and a link back helps people find the source of a figure they
        want to check.
      </p>
      <p>
        The code is open source; see the <ExternalLink href={GITHUB_REPO}>repository</ExternalLink>{" "}
        for its licence, which governs the code rather than this service.
      </p>
    </>
  ),
  Liability: (
    <>
      <p>
        To the fullest extent permitted by law, Metagraphed is provided without warranty of any
        kind, and we are not liable for any loss arising from use of, or inability to use, this
        service or its data — including trading losses, missed opportunities, or downstream failures
        in systems that depend on it.
      </p>
    </>
  ),
  Changes: (
    <>
      <p>
        These terms live in the same repository as the code, so any change is visible in the commit
        history. Continuing to use the service after a change means accepting it.
      </p>
    </>
  ),
  Contact: (
    <>
      <p>
        Questions or disputes:{" "}
        <ExternalLink href="https://github.com/JSONbored/metagraphed/issues">
          open an issue
        </ExternalLink>
        . For security reports, see{" "}
        <ExternalLink href={`${API_BASE}/.well-known/security.txt`}>security.txt</ExternalLink>.
      </p>
    </>
  ),
};

/**
 * Terms (#11627) — the same document treatment as /privacy.
 *
 * Nine sections of prose, a `SectionNav` over their headings, and the sibling
 * links at the foot instead of in a sidebar panel. See `prose-doc-logic.ts`
 * for why the section list is a `Record` the compiler checks rather than two
 * lists kept in step by hand.
 */
export function TermsPage() {
  return (
    <AppShell>
      <EntityHero
        name="Terms of use"
        sentence={
          <FactSentence>
            What you can rely on from Metagraphed, what you cannot, and the few things we ask in
            return.
          </FactSentence>
        }
      />
      <SectionNav items={NAV} />
      <article className="mg-prose">
        {TERMS_SECTIONS.map((title) => (
          <ProseSection key={title} title={title}>
            {BODIES[title]}
          </ProseSection>
        ))}
        <section id="also-relevant" aria-labelledby="also-relevant-h">
          <h2 id="also-relevant-h">Also relevant</h2>
          <ul>
            <li>
              <Link to="/privacy">Privacy policy</Link>
            </li>
            <li>
              <ExternalLink href={`${API_BASE}/auth.md`}>
                auth.md — rate limits &amp; auth
              </ExternalLink>
            </li>
            <li>
              <Link to="/about">Methodology &amp; scope</Link>
            </li>
          </ul>
        </section>
      </article>
    </AppShell>
  );
}
