// #11569: the consent screen, and the one rule that makes it worth having.
//
// Under Client ID Metadata Documents the `client_id` IS a self-hosted URL and
// everything the document says about itself is self-asserted. The MCP
// authorization spec is explicit: the consent screen must display the HOST of
// the client_id URL -- not `client_name` -- as the relying party. A client can
// call itself anything; it cannot choose which host serves its metadata.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import {
  CONSENT_FONT_DATA_URL,
  CONSENT_WORDMARK_SVG,
} from "../src/oauth-consent-assets.ts";
import {
  escapeHtml,
  isLoopbackOnly,
  relyingPartyHost,
  renderConsentPage,
} from "../src/oauth-consent.ts";

const base = {
  clientId: "https://claude.ai/oauth/claude-code-client-metadata",
  redirectUri: "https://claude.ai/api/mcp/auth_callback",
  scopes: ["profile"],
  nonce: "nonce-123",
};

describe("relyingPartyHost", () => {
  test("is the host of an https client_id", () => {
    assert.equal(relyingPartyHost(base.clientId), "claude.ai");
    assert.equal(
      relyingPartyHost("https://evil.example/pretending-to-be/claude.ai"),
      "evil.example",
      "the host is the identity -- a path cannot borrow another party's name",
    );
  });

  test("is null for an https string the URL parser rejects", () => {
    // The scheme test passes but construction throws. Without the catch this
    // would be an unhandled exception ON THE CONSENT PAGE -- the one request
    // where failing closed matters most, since the alternative is rendering an
    // authorization prompt with no relying party on it.
    for (const id of ["https://", "https://[", "https://a b"]) {
      assert.equal(relyingPartyHost(id), null, id);
    }
  });

  test("is null for anything that is not an https URL", () => {
    // A DCR-issued opaque id has no host to show, so the caller falls back to
    // the registered name and must label it as claimed.
    for (const id of [
      "mcp-client",
      "client:abc123",
      "http://claude.ai/meta",
      "not a url",
      "",
    ]) {
      assert.equal(relyingPartyHost(id), null, id);
    }
  });
});

describe("isLoopbackOnly", () => {
  test("is true only when every registered redirect is local", () => {
    assert.equal(isLoopbackOnly(["http://localhost:3118/callback"]), true);
    assert.equal(isLoopbackOnly(["http://127.0.0.1/callback"]), true);
    assert.equal(
      isLoopbackOnly(["http://localhost/cb", "https://claude.ai/cb"]),
      false,
      "one remote redirect means the client is not purely local",
    );
  });

  test("is false for an empty list, which is an absence and not a finding", () => {
    assert.equal(isLoopbackOnly([]), false);
  });

  test("a malformed uri does not make the set look local", () => {
    assert.equal(isLoopbackOnly(["::::"]), false);
  });
});

describe("escapeHtml", () => {
  test("neutralises every character that could break out of markup", () => {
    assert.equal(
      escapeHtml(`<script>alert("x")&'`),
      "&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;",
    );
  });
});

describe("renderConsentPage", () => {
  test("names the client_id HOST as the relying party", () => {
    const html = renderConsentPage(base);
    assert.match(html, /claude\.ai/);
    assert.match(html, /asking to connect/);
  });

  test("a self-reported name NEVER stands in for a verified host", () => {
    // The attack this blocks: a client registers `clientName: "claude.ai"` and
    // a user reads it as the real thing. When there is no host to show, the
    // name is shown WITH the qualifier, never bare.
    const html = renderConsentPage({
      ...base,
      clientId: "opaque-dcr-id",
      clientName: "claude.ai",
    });
    assert.match(html, /name self-reported/);
  });

  test("a host, when present, wins over whatever the client calls itself", () => {
    const html = renderConsentPage({
      ...base,
      clientName: "Totally Legitimate Software",
    });
    assert.match(html, /claude\.ai/);
    assert.doesNotMatch(
      html,
      /Totally Legitimate Software/,
      "a self-asserted name must not appear as the identity when a host exists",
    );
  });

  test("escapes every caller-supplied value", () => {
    // client_id and redirect_uri arrive in a query string from an
    // unauthenticated request and land in HTML.
    const html = renderConsentPage({
      ...base,
      clientId: "<img src=x onerror=alert(1)>",
      clientName: '"><script>alert(1)</script>',
      redirectUri: "<svg/onload=alert(1)>",
      scopes: ["<b>profile</b>"],
      nonce: '"><script>',
    });
    assert.doesNotMatch(html, /<script>alert/);
    assert.doesNotMatch(html, /onerror=/);
    assert.doesNotMatch(html, /<svg\/onload/);
    assert.match(html, /&lt;/);
  });

  test("warns when the client is loopback-only", () => {
    const html = renderConsentPage({
      ...base,
      registeredRedirectUris: ["http://localhost:3118/callback"],
    });
    assert.match(html, /runs on your own machine/);
  });

  test("does not warn for a remote client", () => {
    const html = renderConsentPage({
      ...base,
      registeredRedirectUris: ["https://claude.ai/api/mcp/auth_callback"],
    });
    assert.doesNotMatch(html, /runs on your own machine/);
  });

  test("states what each scope actually permits, not just its name", () => {
    // A scope name is jargon. The decision the page asks for is only
    // meaningful if the reader is told what it grants.
    const html = renderConsentPage({
      ...base,
      scopes: ["profile", "offline_access"],
    });
    assert.match(html, /Read your GitHub username/);
    assert.match(html, /Stay signed in/);
  });

  test("an unrecognised scope is still shown, not silently dropped", () => {
    // Omitting it would understate the grant, which is the one direction a
    // consent screen must never err in.
    const html = renderConsentPage({ ...base, scopes: ["future:scope"] });
    assert.match(html, /future:scope/);
  });

  test("shows where the code will be sent, by host", () => {
    assert.match(renderConsentPage(base), /claude\.ai/);
  });

  test("carries the nonce so the approval can be bound to this request", () => {
    assert.match(
      renderConsentPage(base),
      /name="consent_nonce" value="nonce-123"/,
    );
  });

  test("is self-contained: no external stylesheet, script, or font host", () => {
    // This page is where a user hands over an identity. A third-party request
    // in it is both a privacy leak and one more thing that can fail here.
    const html = renderConsentPage(base);
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /https:\/\/fonts\./);
    assert.doesNotMatch(html, /<link[^>]+stylesheet/i);
  });

  test("asks search engines not to index it", () => {
    assert.match(renderConsentPage(base), /noindex/);
  });

  test("the inline font and adaptive wordmark match the current website assets", () => {
    assert.deepEqual(
      Buffer.from(CONSENT_FONT_DATA_URL.split(",")[1], "base64"),
      readFileSync(
        new URL(
          "../packages/ui-kit/src/fonts/Geist-latin-variable.woff2",
          import.meta.url,
        ),
      ),
    );
    const wordmark = readFileSync(
      new URL(
        "../packages/ui-kit/src/components/metagraphed/wordmark.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    const svg = wordmark
      .match(/<svg\b[\s\S]*?<\/svg>/)![0]
      .replace(/\s+className=\{className\}/, "")
      .replace(/\s+/g, " ");
    assert.equal(CONSENT_WORDMARK_SVG, svg);
    const html = renderConsentPage(base);
    assert.ok(html.includes(CONSENT_FONT_DATA_URL));
    assert.ok(html.includes(CONSENT_WORDMARK_SVG));
  });

  test("light and dark colors and geometry stay on the website token system", () => {
    const css = readFileSync(
      new URL("../packages/ui-kit/src/styles.css", import.meta.url),
      "utf8",
    );
    const style = renderConsentPage(base).match(
      /<style>([\s\S]*?)<\/style>/,
    )![1];
    const declarations = (source: string) =>
      Object.fromEntries(
        [...source.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [
          match[1],
          match[2],
        ]),
      );
    const canonicalLight = declarations(
      css.slice(css.indexOf(":root {"), css.indexOf(".dark {")),
    );
    const canonicalDark = declarations(
      css.match(/\.dark \{([\s\S]*?)\n\}/)![1],
    );
    const [light, rest] = style.split("@media (prefers-color-scheme: dark)");
    const dark = rest.slice(0, rest.indexOf("\n      *"));
    for (const [name, value] of Object.entries(declarations(light)))
      assert.equal(value, canonicalLight[name], `light ${name}`);
    for (const [name, value] of Object.entries(declarations(dark)))
      assert.equal(value, canonicalDark[name], `dark ${name}`);
    assert.match(
      style,
      /font: 13px\/1\.5 "Geist", ui-sans-serif, system-ui, sans-serif/,
    );
    assert.doesNotMatch(style, /(?:animation|transition)\s*:/);
    assert.match(style, /:focus-visible/);
  });

  test("approval stays an explicit POST, with an unchanged nonce and Cancel destination", () => {
    const html = renderConsentPage(base);
    assert.match(html, /<form method="POST" action="\/authorize">/);
    assert.match(html, /type="submit" name="approve" value="yes"/);
    assert.match(html, /<a class="button secondary" href="\/">Cancel<\/a>/);
    assert.doesNotMatch(html, /<meta[^>]+http-equiv="refresh"/i);
    assert.doesNotMatch(html, /(?:src|href)="https?:\/\//i);
  });
});
