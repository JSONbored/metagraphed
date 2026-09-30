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

import {
  CONSENT_FONT_DATA_URL,
  CONSENT_WORDMARK_SVG,
} from "./oauth-consent-assets.ts";

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
 * Mirrors packages/ui-kit/src/styles.css: Geist, paper/graphite, the 4px
 * radius, green focus and the violet agent accent. Tests pin token and asset
 * parity so this Worker-rendered page stays part of the same product.
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
    <title>Connect to Metagraphed</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <meta name="color-scheme" content="light dark" />
    <style>
      @font-face { font-family: "Geist"; font-style: normal; font-weight: 100 900; font-display: swap; src: url("${CONSENT_FONT_DATA_URL}") format("woff2"); }
      :root {
        --canvas: #f8f8f5; --surface-card: #ffffff; --layer: #f0f0ec;
        --ink-strong: #161616; --ink: #4a4a47; --ink-muted: #6b6b67;
        --rule: rgba(22, 22, 22, 0.11); --rule-strong: rgba(22, 22, 22, 0.24);
        --accent: #0f8f66; --accent-foreground: #ffffff; --focus: #0f8f66;
        --agent: #6946d7; --warn: #a86a00; --radius: 4px;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --canvas: #161616; --surface-card: #1f1f1f; --layer: #1f1f1f;
          --ink-strong: #f2f2f2; --ink: #d4d4d4; --ink-muted: #a3a3a3;
          --rule: rgba(255, 255, 255, 0.11); --rule-strong: rgba(255, 255, 255, 0.24);
          --accent: #3ddc97; --accent-foreground: #161616; --focus: #3ddc97;
          --agent: #b49cff; --warn: #e9b84a;
        }
      }
      * { box-sizing: border-box; }
      body { margin: 0; font: 13px/1.5 "Geist", ui-sans-serif, system-ui, sans-serif; background: var(--canvas); color: var(--ink); }
      .brand-header { min-height: 60px; border-bottom: 1px solid var(--rule); display: flex; align-items: center; padding: 16px 24px; }
      .wordmark { color: var(--ink-strong); display: flex; width: 180px; }
      .wordmark svg { display: block; width: 100%; height: auto; }
      .page { min-height: calc(100svh - 60px); display: grid; align-content: center; justify-items: center; padding: 48px 24px; }
      .card { width: 100%; max-width: 560px; padding: 32px; border: 1px solid var(--rule); border-radius: var(--radius); background: var(--surface-card); }
      .connection-icon { width: 44px; height: 44px; padding: 10px; border: 1px solid var(--rule); border-radius: var(--radius); color: var(--agent); margin-bottom: 24px; }
      h1 { font-size: 28px; line-height: 1.25; font-weight: 600; color: var(--ink-strong); margin: 0 0 12px; }
      h2 { font-size: 16px; line-height: 1.55; font-weight: 600; color: var(--ink-strong); margin: 0 0 12px; }
      p { margin: 0; }
      .intro { font-size: 16px; line-height: 1.55; margin-bottom: 24px; }
      .host { color: var(--ink-strong); font-weight: 600; overflow-wrap: anywhere; }
      .claimed { color: var(--ink-muted); font-size: 13px; }
      .connection-details { margin: 0 0 24px; padding: 16px 0; border-block: 1px solid var(--rule); display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 12px 16px; }
      dt { color: var(--ink-muted); }
      dd { margin: 0; color: var(--ink-strong); overflow-wrap: anywhere; }
      .permissions { margin-bottom: 24px; }
      ul { margin: 0; padding-left: 20px; }
      li { padding-left: 4px; margin-bottom: 8px; overflow-wrap: anywhere; }
      li:last-child { margin-bottom: 0; }
      code { font: inherit; font-weight: 500; color: var(--ink-strong); overflow-wrap: anywhere; }
      .warn { border-left: 2px solid var(--warn); background: color-mix(in oklab, var(--warn) 8%, transparent); padding: 12px 16px; margin-bottom: 24px; }
      .warn strong { display: block; color: var(--ink-strong); margin-bottom: 4px; }
      .actions { display: flex; gap: 12px; }
      .button { min-height: 44px; display: inline-flex; justify-content: center; align-items: center; gap: 8px; padding: 10px 16px; border-radius: var(--radius); font: inherit; font-weight: 500; cursor: pointer; text-decoration: none; border: 1px solid transparent; }
      .button svg { width: 18px; height: 18px; flex-shrink: 0; }
      .primary { flex: 1; background: var(--accent); color: var(--accent-foreground); }
      .primary:hover { background: color-mix(in oklab, var(--accent) 90%, var(--ink-strong)); }
      .secondary { background: transparent; color: var(--ink-strong); border-color: var(--rule-strong); }
      .secondary:hover { background: var(--layer); }
      a:focus-visible, button:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
      footer { margin-top: 24px; padding-top: 24px; border-top: 1px solid var(--rule); color: var(--ink-muted); }
      footer a { color: var(--ink-strong); text-underline-offset: 3px; }
      .return-note { max-width: 560px; margin-top: 16px; color: var(--ink-muted); text-align: center; }
      @media (max-width: 480px) {
        .brand-header { padding-inline: 20px; }
        .page { padding: 24px 16px; align-content: start; }
        .card { padding: 24px; }
        .connection-details { grid-template-columns: 1fr; gap: 4px; }
        .connection-details dd + dt { margin-top: 12px; }
        .actions { flex-direction: column; }
      }
    </style>
  </head>
  <body>
    <header class="brand-header"><div class="wordmark">${CONSENT_WORDMARK_SVG}</div></header>
    <main class="page">
    <section class="card" aria-labelledby="connect-title">
      <svg class="connection-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m8 12 4 4m0-8 4 4M7 7l-2 2a4 4 0 0 0 0 6l1 1a4 4 0 0 0 6 0l2-2m-4-4 2-2a4 4 0 0 1 6 0l1 1a4 4 0 0 1 0 6l-2 2" /></svg>
      <h1 id="connect-title">Connect your MCP client</h1>
      <p class="intro">${identity} is asking to connect to your metagraphed account.</p>
      ${loopbackWarning}
      <dl class="connection-details">
        <dt>Signing in with</dt>
        <dd>Your GitHub account</dd>
        <dt>Returns you to</dt>
        <dd><code>${escapeHtml(redirectHost)}</code></dd>
      </dl>
      <section class="permissions" aria-labelledby="permissions-title">
        <h2 id="permissions-title">Requested access</h2>
        <ul>${view.scopes.map(scopeRow).join("")}</ul>
      </section>
      <form method="POST" action="/authorize">
        <input type="hidden" name="consent_nonce" value="${escapeHtml(view.nonce)}" />
        <div class="actions">
          <button class="button primary" type="submit" name="approve" value="yes"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M9 19c-4 1-4-2-6-2m12 4v-4a3.5 3.5 0 0 0-1-3c3 0 6-2 6-5a5 5 0 0 0-1-3c0-1 0-2-1-3-2 0-3 1-3 1a11 11 0 0 0-6 0S8 3 6 3c-1 1-1 2-1 3a5 5 0 0 0-1 3c0 3 3 5 6 5a3.5 3.5 0 0 0-1 3v4" /></svg>Continue to GitHub</button>
          <a class="button secondary" href="/">Cancel</a>
        </div>
      </form>
      <footer>
        metagraphed never sees your GitHub password, and this grant can be
        revoked at any time. See <a href="/auth.md">auth.md</a> for what
        authenticating changes.
      </footer>
    </section>
    <p class="return-note">After signing in, you’ll return to your MCP client.</p>
    </main>
  </body>
</html>`;
}
