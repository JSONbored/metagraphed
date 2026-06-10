# Publishing `@jsonbored/metagraphed`

Releases use **npm OIDC trusted publishing** — no `NPM_TOKEN` is stored. The
`publish-client.yml` workflow authenticates to npm via GitHub's OIDC token and
publishes with provenance. Same pattern as `@heyclaude/mcp`.

## One-time setup (npm side — must be done once before the first OIDC release)

The package publishes under your existing **`@jsonbored`** npm user-scope — **no
org to create**. But npm requires a package to **exist** before you can attach a
Trusted Publisher, so a brand-new package needs one bootstrap step:

1. **Bootstrap the package so it exists** (pick one):
   - Modern (npm 11.10.0+): `npm trust` to register the trusted publisher without
     a placeholder publish, **or**
   - Bootstrap publish from a clean checkout of `main`:
     ```sh
     npm login                       # your existing account that owns @jsonbored
     cd packages/client && npm publish --access public
     ```
     (One-time only; all later releases are tokenless via the workflow.
     `--access public` is required for a scoped package's first publish.)
2. **Add the Trusted Publisher** at npmjs.com → package `@jsonbored/metagraphed` →
   _Settings_ → _Trusted Publisher_ → **GitHub Actions**:
   - Organization or user: `JSONbored`
   - Repository: `metagraphed`
   - Workflow filename: `publish-client.yml`
   - Environment name: `npm-production`
   - Allowed action: `npm publish`
3. **Create the `npm-production` GitHub Environment** (repo → Settings →
   Environments → `npm-production`; add required reviewers if you want a manual
   approval gate before each publish).

## Cutting a release (every time after setup)

1. Bump `version` in `packages/client/package.json` on `main` (strict semver, no
   `v` prefix) and merge.
2. Run the **Publish client SDK** workflow (Actions → _Publish client SDK_ →
   _Run workflow_). It validates the version (tag + npm version must not already
   exist), builds, `npm publish --provenance` via OIDC, then creates the
   `client-v<version>` tag + a GitHub release.

Requirements (handled by the workflow): npm CLI ≥ 11.5.1, Node ≥ 22.14
(workflow pins 24.16.0), `id-token: write`, `registry-url: https://registry.npmjs.org`.
