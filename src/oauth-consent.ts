// The authorization consent screen (#11569).
//
// ## WHY THIS EXISTS AT ALL
//
// `/authorize` used to redirect straight to GitHub. The user saw GitHub's own
// "Authorize metagraphed" page and was never told WHICH MCP client had asked --
// so the one decision they were actually making, "do I let this client act as
// me", was the one thing the flow never showed them.
//
// That was tolerable while every client arrived through Dynamic Client
// Registration, where the client at least presented itself to us first. It is
// not tolerable under Client ID Metadata Documents, where the `client_id` IS a
// self-hosted URL and the metadata behind it is self-asserted. The MCP
// authorization specification is explicit about the consequence:
//
//   Because the document is self-asserted, the consent screen must display the
//   HOST of the client_id URL (not the client_name field) as the relying party.
//
// So the identity shown here is derived from the URL, never from anything the
// document claims about itself. A client may call itself whatever it likes; it
// cannot choose which host serves its metadata.
//
// ## WHAT IS TRUSTED, AND WHAT IS MERELY DISPLAYED
//
// TRUSTED: the client_id URL's host, and the redirect_uri's host. Both are
// structural -- the flow cannot complete anywhere else.
//
// DISPLAYED, LABELLED AS CLAIMED: a registered client's name. Shown because a
// bare host is not always recognisable, and withheld from any position where a
// reader could mistake it for verified.
//
// Every caller-supplied value is escaped on the way in. These strings arrive in
// a query parameter from an unauthenticated request and land in HTML.

/** The one place caller-supplied text becomes markup. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The relying party, as the consent screen may state it.
 *
 * A CIMD `client_id` is an HTTPS URL and its host is the identity. Anything
 * else (a DCR-issued opaque id) has no host to show, so the caller falls back
 * to the registered name -- clearly labelled as self-reported, because it is.
 */
export function relyingPartyHost(clientId: string): string | null {
  if (!/^https:\/\//i.test(clientId)) return null;
  try {
    // NO `|| null` FALLBACK on the host. The WHATWG parser requires a
    // non-empty host for a special scheme, so every `https://` string that
    // parses at all has one -- verified against `https://`, `https://#f`,
    // `https://?q`, `https://:80`, `https://@` and `https://%20`, all of which
    // throw rather than yielding an empty host. An arm no input can reach
    // hides a future shape change instead of surfacing it.
    return new URL(clientId).host;
  } catch {
    return null;
  }
}

/**
 * Is every redirect target a loopback address?
 *
 * The MCP authorization spec calls this out: a Client ID Metadata Document is
 * self-asserted, so any local process can bind a port and claim to be the
 * legitimate client. It recommends warning when the ONLY registered redirect
 * URIs are loopback, which is exactly the case a user cannot distinguish by
 * looking at the name.
 */
export function isLoopbackOnly(redirectUris: readonly string[]): boolean {
  if (redirectUris.length === 0) return false;
  return redirectUris.every((uri) => {
    try {
      const { hostname } = new URL(uri);
      return (
        hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname === "::1"
      );
    } catch {
      return false;
    }
  });
}

export interface ConsentView {
  /** The `client_id` exactly as presented. */
  clientId: string;
  /** The client's self-reported name, when it registered one. */
  clientName?: string | null;
  /** Where the authorization code will be sent. */
  redirectUri: string;
  /** Every redirect URI this client registered, for the loopback check. */
  registeredRedirectUris?: readonly string[];
  /** Scopes being requested. */
  scopes: readonly string[];
  /** CSRF token; echoed back by the form. */
  nonce: string;
}

/** What a scope actually lets the client do, in words a person can act on. */
const SCOPE_DESCRIPTIONS: Record<string, string> = {
  profile: "Read your GitHub username, to identify your account here.",
  offline_access: "Stay signed in without asking you again each time.",
};

function scopeRow(scope: string): string {
  const described = SCOPE_DESCRIPTIONS[scope];
  return `<li><code>${escapeHtml(scope)}</code>${
    described ? ` — ${escapeHtml(described)}` : ""
  }</li>`;
}

/**
 * Render the consent screen.
 *
 * The style block is the one apps/ui/src/lib/error-page.ts and
 * rate-limited-response.ts already share, verbatim where it applies -- same
 * type stack, ground, greys, radii and .primary/.secondary buttons. A consent
 * screen inventing its own palette would look like a different product at the
 * exact moment a user is deciding whether to trust this one. The additions
 * (the definition list, the warning box) follow the same scale.
 *
 * Self-contained: no external stylesheet, no script, no font host. This page is
 * where a user hands over an identity, and a third-party request in it is both
 * a privacy leak and one more thing that can fail at the worst moment.
 */
export function renderConsentPage(view: ConsentView): string {
  const host = relyingPartyHost(view.clientId);
  // The identity line. A CIMD host is structural and stated plainly; anything
  // else is a claim and is marked as one.
  const identity = host
    ? `<strong class="host">${escapeHtml(host)}</strong>`
    : `<strong class="host">${escapeHtml(
        view.clientName?.trim() || view.clientId,
      )}</strong> <span class="claimed">(name self-reported)</span>`;
  const redirectHost = (() => {
    try {
      return new URL(view.redirectUri).host;
    } catch {
      return view.redirectUri;
    }
  })();
  const loopbackWarning = isLoopbackOnly(view.registeredRedirectUris ?? [])
    ? `<p class="warn"><strong>This client runs on your own machine.</strong>
       Its identity cannot be verified beyond the address above — any program on
       this computer could present it. Continue only if you started it
       yourself.</p>`
    : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Authorize access</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <style>
      body { font: 15px/1.5 system-ui, -apple-system, sans-serif; background: #fafafa; color: #111; display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 1.5rem; }
      .card { max-width: 28rem; width: 100%; padding: 2rem; }
      h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
      p { color: #4b5563; margin: 0 0 1.5rem; }
      .host { color: #111; font-weight: 600; word-break: break-all; }
      .claimed { color: #6b7280; font-weight: 400; }
      dl { margin: 0 0 1.5rem; padding: 1rem; background: #fff; border: 1px solid #d1d5db; border-radius: 0.375rem; }
      dt { font-size: 0.75rem; letter-spacing: 0.05em; text-transform: uppercase; color: #6b7280; margin-bottom: 0.15rem; }
      dd { margin: 0 0 0.85rem; color: #111; word-break: break-all; }
      dd:last-child { margin-bottom: 0; }
      ul { margin: 0.25rem 0 0; padding-left: 1.1rem; color: #4b5563; }
      li { margin-bottom: 0.25rem; }
      code { font: 0.9em ui-monospace, SFMono-Regular, Menlo, monospace; background: #f3f4f6; padding: 0.1rem 0.3rem; border-radius: 0.25rem; color: #111; }
      .warn { background: #fffbeb; border: 1px solid #fde68a; color: #92400e; border-radius: 0.375rem; padding: 0.75rem 1rem; margin: 0 0 1.5rem; }
      .actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
      a, button { padding: 0.5rem 1rem; border-radius: 0.375rem; font: inherit; cursor: pointer; text-decoration: none; border: 1px solid transparent; }
      .primary { background: #111; color: #fff; }
      .secondary { background: #fff; color: #111; border-color: #d1d5db; }
      footer { margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid #e5e7eb; color: #6b7280; font-size: 0.85rem; }
      footer a { padding: 0; border: 0; color: #111; text-decoration: underline; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Authorize access</h1>
      <p>${identity} is asking to connect to your metagraphed account.</p>
      ${loopbackWarning}
      <dl>
        <dt>Signing in with</dt>
        <dd>Your GitHub account</dd>
        <dt>Returns you to</dt>
        <dd><code>${escapeHtml(redirectHost)}</code></dd>
        <dt>It will be able to</dt>
        <dd><ul>${view.scopes.map(scopeRow).join("")}</ul></dd>
      </dl>
      <form method="POST" action="/authorize">
        <input type="hidden" name="consent_nonce" value="${escapeHtml(view.nonce)}" />
        <div class="actions">
          <button class="primary" type="submit" name="approve" value="yes">Continue to GitHub</button>
          <a class="secondary" href="/">Cancel</a>
        </div>
      </form>
      <footer>
        metagraphed never sees your GitHub password, and this grant can be
        revoked at any time. See <a href="/auth.md">auth.md</a> for what
        authenticating changes.
      </footer>
    </div>
  </body>
</html>`;
}
