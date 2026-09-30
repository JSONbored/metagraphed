// Fixed visual fixture from fb69e2f9d451ac27920559b8f2f4a3736ff459f1.
// Same client, scopes and nonce as oauth-consent.spec.ts; no live requests.
export const BEFORE_CONSENT_HTML = `<!doctype html>
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
      <p><strong class="host">claude.ai</strong> is asking to connect to your metagraphed account.</p>
      
      <dl>
        <dt>Signing in with</dt>
        <dd>Your GitHub account</dd>
        <dt>Returns you to</dt>
        <dd><code>claude.ai</code></dd>
        <dt>It will be able to</dt>
        <dd><ul><li><code>profile</code> — Read your GitHub username, to identify your account here.</li><li><code>offline_access</code> — Stay signed in without asking you again each time.</li></ul></dd>
      </dl>
      <form method="POST" action="/authorize">
        <input type="hidden" name="consent_nonce" value="fixture-consent-nonce" />
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
