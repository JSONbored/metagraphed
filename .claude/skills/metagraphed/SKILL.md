---
name: metagraphed
description: >-
  Use when writing, validating, or preparing ANY contribution or pull request to the
  JSONbored/metagraphed repo — adding/enriching a subnet's public surfaces (the most common
  contribution), a code/schema change to the Worker API or build scripts, picking an issue,
  running the local gates, and formatting the commit + PR. metagraphed reviews PRs ONE-SHOT via
  the Gittensory Gate (the GitHub App that auto-merges/auto-closes) plus a strict CI suite; there
  is no review back-and-forth, so a PR must be correct, in-scope, and green before it is pushed.
  Surfaces live in ONE file per subnet (registry/subnets/<slug>.json) — never per-surface
  candidate files, never split across multiple PRs. Also covers frontend PRs against apps/ui/
  (the web app, folded into this repo via monorepo consolidation) — visual changes require a
  before/after screenshot table and are always held for manual review. Invoke for any "contribute
  to / open a PR against / enrich a subnet in / add a surface to / fix a bug in / add a frontend
  feature to metagraphed" task.
---

# Contributing to metagraphed — the one-shot PR playbook

metagraphed is the Bittensor subnet **integration registry** — every subnet, metagraphed. The repo
is a Cloudflare Worker API + Node build scripts; **JSON Schema is the canonical contract** (→ OpenAPI
→ typed clients), and everything under `public/metagraph/` is a _generated projection_ of reviewed
source, never hand-authored truth.

It merges through an **automated, one-shot review**: the **Gittensory Gate** (a GitHub App that posts
`Gittensory Gate` + `Gittensory Context` checks and a single verdict) plus a **strict CI suite**
(`Validate`). There is no human ping-pong and no "fix it in review" — **the PR must be right before
you push.** This skill is the end-to-end procedure to make that happen with AI tools (Claude Code /
Codex).

Work through the phases **in order** for your contribution type. If you cannot get the local gate
green, **do not push** — an incomplete PR is auto-closed or held, not coached.

`reference.md` (next to this file) has the exhaustive tables — every CI check, the surface schema,
the `kind` enum, the gate disposition, the validator list, the commit/PR rubric. Read it when a phase
says to.

**Zero-setup environment:** if you're operating in a devcontainer-aware tool, open the repo there —
`.devcontainer/devcontainer.json` pins Node 22 and preinstalls Playwright's Chromium (needed for
Phase C2's screenshot contract), so `npm install` is the only remaining step. Otherwise `.nvmrc` at
the repo root pins Node 22 for `nvm use`.

---

## Three kinds of contribution — pick your path

| You are…                                                                                                      | Path                                             | Files you touch                                                                 |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------- |
| **Adding or enriching a subnet's public surfaces** (API, OpenAPI, docs, repo, dashboard, SDK, data artifact…) | **Path A — Surface contribution** (Phases A0–A5) | **exactly one** `registry/subnets/<slug>.json`                                  |
| **Changing code, schemas, or build scripts** (Worker API, `schemas/`, `scripts/`, workflows)                  | **Path B — Code/schema PR** (Phases B0–B5)       | `src/`, `workers/`, `schemas/`, `scripts/`, `.github/`, + regenerated artifacts |
| **Fixing a bug or shipping a feature in the web app** (block explorer, docs pages, dev tools)                 | **Path C — Frontend PR** (below)                 | `apps/ui/**` only                                                               |

Most contributions are **Path A**. Do **not** mix any of the three in one PR.

---

## What the gate does to your PR — it merges and closes, automatically

The Gittensory Gate is **not advisory**. Once your checks settle, for a **contributor** PR (you are
not the repo owner or an automation bot) it takes a one-shot disposition:

| Situation                                                                                                                                                         | Gate action                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Content **verified** (owner-matched, fresh, grounded) + **both** AI reviewers confidently approve (≥0.9) + CI green + mergeable-clean                             | **auto-approve → MERGE**            |
| A **deterministic fail** — duplicate surface, placeholder, private/localhost URL, secret, dead `source_url`                                                       | **CLOSE** (one-shot)                |
| **Every** reviewer returns a clear reject                                                                                                                         | **CLOSE** (one-shot)                |
| Any CI check failed                                                                                                                                               | **CLOSE** (cites the failing check) |
| Legitimate but **uncertain** — a reviewer wanted merge but under 0.9, a reviewer said `manual`, reviewers split, owner-mismatch, stale repo, unfetchable evidence | **MANUAL** (held, not closed)       |
| CI still pending / unverified fork run                                                                                                                            | **no action** — waits               |

So a flawed contributor PR is **closed, not coached** — recovery means fixing the problem and opening
a **fresh** PR. **Verified + green ⇒ merged; a clear adverse signal ⇒ closed; genuine uncertainty ⇒
held for a human.** (Owner / automation-bot PRs are exempt from auto-close — but assume you are a
contributor.)

---

## The non-negotiables (read once, hold throughout)

1. **One subnet = one file = one PR.** A surface contribution edits **exactly one**
   `registry/subnets/<slug>.json` and **nothing else** (no generated artifacts, no scripts, no other
   subnet). You may add **several surfaces for that one subnet in the same diff** — that is one merge,
   the way it should be. **Never** split a subnet's surfaces across multiple PRs and **never** re-title
   the same surface as a different `kind` to make it look new: the gate dedups within the file and
   **closes redundant/near-duplicate PRs**. (This is exactly the farming the single-file model exists to
   stop.)
2. **Prove the claim.** Every surface needs a public `url` **and** a `source_urls` entry that
   _independently proves_ the subnet/operator actually publishes it (an official repo README, the
   provider's own site, on-chain identity). A `source_url` that 404s or doesn't back the claim → closed.
3. **Don't invent surfaces.** Only register what a subnet actually exposes. Schema-valid ≠ accepted.
4. **Health is probe-derived only.** Never hand-set health, uptime, latency, incidents, or
   `verification` — the build's prober owns those. You set identity (`url`, `kind`, `provider`,
   `source_urls`) and `review.state: community-submitted`; the gate and build do the rest.
5. **Public-safe only.** No secrets, PATs, wallet/hotkey/coldkey paths, private/localhost URLs, or
   validator-local data anywhere — in files, commits, or PR text. `auth` fields are _placeholders_
   (`Bearer <token>`), never real credentials.
6. **Link an open issue — required.** Every PR must reference an issue (`Closes #<n>` / `Refs #<n>`)
   in the PR body, and that issue must be **open/unclosed** at submission time — the gate verifies the
   PR against that issue's intent, clause by clause. No linked issue, or a linked issue that's already
   closed, is an automatic close on its own, before content is even scored. For surface work, the
   per-subnet enrichment issues under [epic #427](https://github.com/JSONbored/metagraphed/issues/427)
   are the natural home to link — pick one that's still open before you start.
7. **Schema is the contract — regenerate + commit (Path B).** Editing `schemas/` means
   `npm run build` then committing `openapi.json` + types/clients in the same PR, or
   `validate:contract-drift` fails CI.
8. **Conventional Commits, no AI attribution.** Lowercase scope, specific subject, no trailing period;
   **no AI/Claude/agent mention** anywhere in commits or PR text. Frontend/UI work lives in this repo
   at `apps/ui/` — see **Path C** below; it is not Path A or Path B.

---

## Path A — Surface contribution (the common case)

### Phase A0 — Bootstrap

```sh
# External contributor? Fork JSONbored/metagraphed, then clone YOUR fork:
git clone https://github.com/<you>/metagraphed && cd metagraphed
git remote add upstream https://github.com/JSONbored/metagraphed
nvm use            # Node 22 (engines: >=22.23.0)
npm install        # required before any validator runs
```

### Phase A1 — Pick the subnet + find a real surface

- **Search first.** Check open issues AND open PRs for the same subnet/surface — a duplicate is a
  close-worthy signal. Browse [`good first issue`](https://github.com/JSONbored/metagraphed/labels/good%20first%20issue)
  / [`help wanted`](https://github.com/JSONbored/metagraphed/labels/help%20wanted); the per-subnet
  enrichment issues (#427) each name the exact gap.
- **Find the gap.** `npm run curation:brief` lists profile-light subnets (directory-only, no website /
  source repo, public APIs with no OpenAPI yet). See `docs/curation-playbook.md`.
- **Confirm the surface is real and public.** A safe public `url` you can fetch, plus a `source_url`
  that proves the subnet publishes it. Pick the right `kind` (full enum in `reference.md`): contributor
  kinds are `docs, website, source-repo, openapi, subnet-api, dashboard, sse, data-artifact, sdk,
example, repo-registry` — all auto-reviewable; authed/paid APIs + unknown providers are higher-trust
  (airtight ownership proof). Base-layer chain endpoints (`subtensor-rpc/wss`, `archive`) are
  maintainer-curated infra (the endpoint lane), not contributor surfaces.
  **Prefer high-value callable kinds** (`openapi`, `subnet-api`, `sse`, `data-artifact`, `sdk`) —
  `source-repo` and `website` are auto-promoted from on-chain identity data, and `validate:surface`
  rejects them if the machine already has the URL (CI fails → gate closes). See `reference.md §5`.

### Phase A2 — Edit the ONE subnet file

A surface contribution adds entries to the `surfaces[]` array of `registry/subnets/<slug>.json`. Use
the helper so the id/shape are correct:

```sh
# Find the provider slug for the team behind the surface.
npm run providers:list

# Append a community surface to the subnet file (writes into registry/subnets/<slug>.json):
npm run surface:add -- \
  --netuid 43 --kind subnet-api \
  --url https://api.example.com/v1 \
  --source-url https://github.com/example/project/blob/main/README.md \
  --provider <provider-slug> --submitted-by <github-login> --write
  # Debut provider (slug not registered)? Add the team identity and surface:add scaffolds
  # registry/providers/<slug>.json (flat — trust is the authority field) in the SAME PR.
  # --provider-url is the provider's website_url and MUST be a public URL (validate
  # rejects private/localhost), as must any logo/docs/github/team/contact/social URL:
  #   --provider-name "Example Team" --provider-url https://example.com
```

Each added surface must carry `authority: "community"` and a `review` block — the helper sets these:

```jsonc
{
  "id": "sn-43-example-subnet-api",
  "name": "Example subnet API",
  "kind": "subnet-api",
  "url": "https://api.example.com/v1",
  "provider": "example",
  "authority": "community", // existing enum value — community-submitted, not official truth
  "auth_required": false,
  "public_safe": true,
  "source_urls": ["https://github.com/example/project/blob/main/README.md"],
  "review": {
    "state": "community-submitted",
    "submitted_by": "<github-login>",
  },
  "notes": "One line on what it is / why it's the right surface.",
}
```

You set **identity + proof + `review.state: community-submitted`** only. For an existing subnet
manifest, **do not** add `verification`, health, or `curation` changes, and **do not** touch other
surfaces or top-level fields in the file — a community PR that edits anything beyond appending its own
community surface(s) is out-of-shape and gets routed to full review or closed. A missing subnet
manifest is the exception: `subnet:new` creates the required top-level scaffold fields, then
`surface:add` appends the community surface in that same new file. `review.state` is the
human-governance axis: a maintainer flips it → `maintainer-reviewed` (or `rejected`) in place; machine
verification + freshness is the separate probe overlay (the build's prober fills
`verification`/health).

> New subnet not yet in `registry/subnets/`? Scaffold it with `npm run subnet:new -- --netuid <n>`
> first (one file), then add your surface to it in the same PR.

### Phase A3 — Validate locally

```sh
npm run validate:surface -- registry/subnets/<slug>.json   # schema + provider-slug + review-shape
npm run scan:public-safety                                  # no secrets / private URLs
```

Fix every finding. (CI runs the full `validate` suite; these two are the fast local pre-checks for the
submission lane.)

### Phase A4 — Commit + open the PR

- **One subnet file changed, nothing else.** `git diff --stat` should show a single
  `registry/subnets/<slug>.json`.
- **Commit (Conventional):** `feat(registry): add SN43 Example subnet-api surface (#<issue>)`.
- **PR body:** fill `.github/pull_request_template.md` honestly — a real Summary, the `url` +
  `source_url` proof, the validation commands you ran, and **`Closes #<issue>`** — required, and the
  issue must still be open. No AI attribution.

### Phase A5 — Let the gate adjudicate

Watch `Validate` and `Gittensory Gate` go green. Verified + green → merged. A deterministic fail
(dup / dead source / private URL) or a clear reject → closed; fix and open a fresh PR. Genuine
uncertainty → held for a human — don't open a duplicate.

---

## Path B — Code / schema PR

### Phase B0 — Bootstrap + scope

`npm install` (Node 22). Open an issue first for anything risky (public behavior, schema/contract
changes, new routes, workflows, deps). Keep the PR narrow — one coherent change. **Anchor on existing
code:** find ≥2 analogues in the repo, cite them `file:line`, trace the closest end-to-end, and match
its structure, naming, and comment density. Build for the class, not the one case.

### Phase B1 — Implement (match the house style)

- The Worker entry/router is `workers/api.mjs`; serving/overlay/health logic lives in `src/*.mjs`;
  the contract lives in `schemas/` (+ `schemas/components/`) and `src/contracts.mjs`.
- **Schema-first rule:** never hand-edit the generated contract. Edit `schemas/` →
  `npm run build` → commit `openapi.json` + generated types/clients in the same PR.
- A new `/api/v1` route or artifact trips hidden contract gates — see the new-route checklist in
  `reference.md` before adding one.

### Phase B2 — Test

Tests are vitest under `tests/`. Add coverage for new branches and fallback paths, and a **regression
test for every bug fix**. **Codecov is the coverage gate** — `codecov/patch` enforces **99% patch
coverage, branch-counted, with zero threshold slack** (`target: 99%, threshold: 0%` in `codecov.yml`),
scoped to `src/**` + `workers/**` runtime code. Run it unsharded locally: `npm run test:coverage`.
Reader tests serve R2-only artifacts that only exist after a build, so `npm run build` before the
suite if a test reads served artifacts.

### Phase B3 — Regenerate what you invalidated (then commit it)

| You changed…                                 | Run             | Commit                                                                                            |
| -------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------- |
| `schemas/` or `schemas/components/`          | `npm run build` | `openapi.json`, generated types, `contracts.json`, api-index                                      |
| A new/edited `/api/v1` route or artifact     | `npm run build` | the derived `public/metagraph/*` it produces                                                      |
| A canonical `registry/providers/<slug>.json` | `npm run build` | regenerated artifacts (commit only the provider file + its artifacts)                             |
| MCP tools in `src/mcp-server.mjs`            | —               | **nothing** — the server card is worker-computed, not a committed artifact                        |
| _(any of the above)_                         | `npm run build` | **never** `public/metagraph/r2-manifest.json` / `public/metagraph/schemas/index.json` — see below |

Stale committed artifacts fail the **derived-artifact freshness** + **contract-drift** gates.

**Never commit `public/metagraph/r2-manifest.json` or `public/metagraph/schemas/index.json`.**
`npm run build` always rewrites both to reflect a full local/CI build, but their committed copies on
`main` are owned by the real deploy/publish pipeline (`r2-manifest.json` is the publish lockfile
read from its committed path at publish time; `schemas/index.json` is a network-capture cache the
build reconciles in place) — see the "Verify committed derived artifacts are fresh" step in
`.github/workflows/validate.yml`, which explicitly excludes both for this reason. A contributor
build will **always** show them as changed for reasons unrelated to your change. After
`npm run build`, always revert them against your **base** remote — `upstream/main` if you forked
per Phase A0, or `origin/main` if you cloned this repo directly (no `upstream` configured):

```sh
git checkout "$(git remote | grep -qx upstream && echo upstream || echo origin)/main" -- \
  public/metagraph/r2-manifest.json public/metagraph/schemas/index.json
```

before staging/committing — even if they show as modified.

**Client SDK version:** do **not** bump `packages/client/package.json` in your PR. The
`sync-client-version` workflow auto-opens a `chore/sync-client-version` PR after a contract-changing
merge. `validate:client-sdk-sync` now emits a notice (not a failure) when the version wasn't bumped
in the contributor PR.

### Phase B4 — Run the gates locally (must be green)

```sh
git diff --check
npm run lint && npm run format:check        # NOTE: main isn't fully prettier-clean — never reformat whole files you didn't change
npm run typecheck                           # tsc --noEmit, whole in-scope tree (src/workers/scripts/tests)
npm run validate                            # registry + API + OpenAPI checks
npm test                                    # or: npm run test:coverage for the coverage gate
# Then the focused validators for what you touched (full list in reference.md), e.g.:
npm run validate:contract-drift  npm run validate:schemas  npm run validate:api  npm run validate:openapi
```

For a faithful full local run, `npm run pipeline:check` — but only trust it in isolation **after** a
clean `npm run build` (see the build-gotchas note in `reference.md`).

### Phase B5 — Commit + PR

Conventional Commit (no AI attribution); `Closes #<issue>` — required, and the issue must still be
open; fill the PR template with the validation commands you actually ran. Sync with `main` if it moved
(`git fetch upstream && git rebase upstream/main`) — a base conflict closes a contributor PR.

---

## Path C — Frontend PR (`apps/ui/`)

`apps/ui/` is the TanStack Start + Vite + React web app at [metagraph.sh](https://metagraph.sh) —
folded into this repo as an npm workspace via the monorepo consolidation. It has its own `ui` CI job
(lint + typecheck + test + a responsive-overflow e2e check + build + bundle-budget, see
`reference.md §2`) and its own review contract,
distinct from Path A/B.

### Phase C0 — Bootstrap + pick an issue

```sh
npm install            # root install wires the apps/ui workspace too (Node 22)
```

Pick a `gittensor:bug` / `gittensor:feature` issue scoped to `apps/ui/` (Wave 3 milestone). Keep the
PR **narrow — aim for ≤10 files / ≤1000 LOC**; if an issue looks bigger than that once you're in the
code, ship the smallest coherent slice and leave a follow-up note rather than bundling everything into
one PR.

### Phase C1 — Implement (match the house style)

- Reuse existing shared components and the design tokens in `apps/ui/src/styles.css` (the "Bone & Ink"
  system — warm bone/paper background, deep ink text, mint accent used **sparingly**, flat surfaces
  with hairline borders, **no shadows or gradients**) instead of inventing new one-off styles.
- Anchor on an existing analogous page/component before writing a new one — this codebase already has
  shared primitives (table-controls, chart primitives, copy/share buttons, entity hover-cards,
  freshness badges) that most issues should compose rather than reimplement.
- Creative additions beyond an issue's stated scope are welcome but held to a **higher bar** — expect
  extra scrutiny, and call out explicitly in the PR body anything you added beyond the issue.

### Phase C2 — Screenshot contract (required for any visual change)

**Non-negotiable for any PR that changes rendered output.** PRs without it are auto-closed — no
exceptions. A real PR (#3757) shipped 10 of its 12 screenshots at 115,000–142,000px tall (a
full-page capture bug, not a display issue) and sat unreviewable until recaptured. Don't repeat
that.

**Recommended: automated capture (#3769).** `apps/ui/tests/e2e/capture-pr-screenshots.mjs`
automates everything below — the two-worktree orchestration, fixed-viewport-only capture, explicit
theme toggling, the 12-image matrix, and (with `--push`) hosting + the ready-to-paste markdown
table:

```sh
npm run screenshots --workspace=apps/ui -- --route /subnets/1 --section volume-24h --prefix 5483-volume --push
```

Add `--section <id>` for a below-the-fold section anchor (omit to capture the page top), and
`--fallback-section <id>` when `before` doesn't have that anchor yet (the common case for a new
section — point it at the existing anchor the new one attaches after). Already have two dev
servers running (e.g. mid-session in an AI coding tool)? Skip the orchestration and point at them
directly: `--before-url http://localhost:8081 --after-url http://localhost:8080`. Run
`npm run screenshots --workspace=apps/ui -- --help` for the full flag list.

If the tool doesn't fit your case (a capture step needs manual intervention, or you're debugging
the tool itself), the equivalent manual steps are below — same contract, same output.

**1. Two dev servers — one for `before`, one for `after`.** Don't reuse a single server for both; run
the `before` state from a separate worktree so nothing needs stashing/restoring mid-capture:

```sh
git worktree add ../metagraphed-before $(git merge-base main HEAD)
cd ../metagraphed-before && npm install && npm run dev --workspace=apps/ui   # note the printed Local URL — this is "before"
cd -                                                                          # back to your feature branch
npm run dev --workspace=apps/ui                                              # note this Local URL — this is "after"
```

**2. Fixed viewport sizes only — never a full-page / `fullPage: true` capture.** A full-scroll-height
capture is exactly what produced #3757's broken screenshots. Use these three sizes — chosen to straddle
this app's actual Tailwind breakpoints (`md`=768px, `lg`=1024px, the two most-used responsive prefixes
in `apps/ui/src`):

| Viewport | Size (px)  |
| -------- | ---------- |
| Mobile   | 375 × 812  |
| Tablet   | 768 × 1024 |
| Desktop  | 1280 × 800 |

Capture exactly that viewport, nothing more. If the changed content is below the fold, scroll to it
first — don't reach for a full-page capture to get there.

**Also never `locator.screenshot()` / `elementHandle.screenshot()`** (e.g.
`page.locator(".hero").screenshot(...)`) as a shortcut to "just the changed part" — confirmed on
#6928/#6933, both shipped with a locator-scoped capture instead of the fixed viewport. It crops to
that element's own rendered box, not the fixed viewport frame this contract requires, so a
reviewer can't see the change in its real page context (surrounding layout, whether anything else
shifted). The only call to make is `page.screenshot({ path })` — no `fullPage`, no locator, after
resizing the viewport and scrolling to the changed content if needed.

**3. Force each theme explicitly — never rely on system/`prefers-color-scheme`** (it varies by capture
environment, so it isn't reproducible run to run). In the page, before capturing:

```js
localStorage.setItem("mg-theme", "dark"); // or "light"
location.reload();
```

`mg-theme` is `THEME_STORAGE_KEY` in `apps/ui/src/lib/theme.ts` — the only supported mechanism. Reload
after setting it so the pre-hydration bootstrap script applies it with no flash-of-wrong-theme.

**4. 3 viewports × 2 themes × {before, after} = 12 images**, for a page/feature-level change. Skip a
combo only if you state in one sentence why it's provably unaffected (e.g. a change gated behind a
desktop-only code path).

**5. Host the 12 files on a dedicated branch in your own fork — never drag-and-drop, never commit them
to your feature branch.** Drag-and-drop into the GitHub web editor requires a human browser session,
which an AI coding tool cannot do end-to-end; a pushed branch is fully scriptable and keeps binary
images out of your feature branch's diff entirely. Do this from a throwaway worktree, not your feature
branch's working directory:

```sh
git worktree add ../metagraphed-screenshots main
cd ../metagraphed-screenshots
git checkout --orphan screenshots       # first time; if you already have a `screenshots` branch from a
git rm -rf . 2>/dev/null                # prior PR, just `git checkout screenshots` instead and skip these two lines
cp /path/to/your/12/*.png .
git add *.png && git commit -m "screenshots for PR"
git push origin screenshots
cd -    # your feature branch's working directory was never touched
```

Reference each file as `https://raw.githubusercontent.com/<your-fork-owner>/metagraphed/screenshots/<file>.png`.

**6. Table format — one row per viewport+theme, thumbnail + caption in each cell, both before and
after:**

```md
| Viewport · Theme | Before                                                                | After                                                              |
| ---------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Desktop · Light  | [<img src="BEFORE_URL" width="260">](BEFORE_URL)<br><sub>before</sub> | [<img src="AFTER_URL" width="260">](AFTER_URL)<br><sub>after</sub> |
| Desktop · Dark   | [<img src="BEFORE_URL" width="260">](BEFORE_URL)<br><sub>before</sub> | [<img src="AFTER_URL" width="260">](AFTER_URL)<br><sub>after</sub> |
| Tablet · Light   | [<img src="BEFORE_URL" width="260">](BEFORE_URL)<br><sub>before</sub> | [<img src="AFTER_URL" width="260">](AFTER_URL)<br><sub>after</sub> |
| Tablet · Dark    | [<img src="BEFORE_URL" width="260">](BEFORE_URL)<br><sub>before</sub> | [<img src="AFTER_URL" width="260">](AFTER_URL)<br><sub>after</sub> |
| Mobile · Light   | [<img src="BEFORE_URL" width="260">](BEFORE_URL)<br><sub>before</sub> | [<img src="AFTER_URL" width="260">](AFTER_URL)<br><sub>after</sub> |
| Mobile · Dark    | [<img src="BEFORE_URL" width="260">](BEFORE_URL)<br><sub>before</sub> | [<img src="AFTER_URL" width="260">](AFTER_URL)<br><sub>after</sub> |
```

Screenshots go **inside the table only** — never pasted loose in the PR body, never committed to the
feature branch itself.

A PR confined to `apps/ui/src/lib/**` / `apps/ui/src/hooks/**` / test files, with **no** visual change,
skips this entirely — it isn't rendering anything different.

> The devcontainer (`.devcontainer/devcontainer.json`) preinstalls Node 22 + Playwright's Chromium, so
> setup for the steps above (manual or via the automated tool) is zero-config there.

**Animated evidence (#4825) — for effects no static screenshot can show.** Required whenever the
changed behavior is only visible in motion: a hover-triggered popover, a scroll-linked effect, a CSS
transition/animation, a drag interaction, or anything else where "before" and "after" aren't just two
different static layouts. This is _additional_ to the static table above, not a replacement for it — a
real PR (#4814) shipped both: the static viewport × theme matrix for the at-rest layout, plus a
before/after GIF table for the hover behavior itself, because a still image genuinely cannot show what
happens on hover.

1. **Record the interaction, don't screenshot it.** Use your OS's screen recording (macOS `Cmd+Shift+5`
   or `screencapture -V`; Linux `wf-recorder`/`ffmpeg -f x11grab`) or a Playwright video/trace, scoped
   tightly to the interactive element — not the full viewport, and not a long clip. A few seconds
   showing the cursor entering, the effect triggering, and the resulting state is enough.
2. **Convert to a GIF** — a `.mov`/`.webm` file won't render inline in a GitHub-hosted `<img>` tag the
   way a `.gif` does:
   ```sh
   ffmpeg -i recording.mov -vf "fps=12,scale=480:-1:flags=lanczos" -loop 0 hover-before.gif
   ```
   Keep it small (a few seconds, ~12fps, ≤480px wide) — an oversized GIF is as unreviewable as #3757's
   full-page screenshot bug was.
3. **Same hosting mechanism as step 5 above — the dedicated `screenshots` branch on your own fork.**
   Push the `.gif` files alongside your PNGs in the same orphan-branch commit; reference them the same
   way: `https://raw.githubusercontent.com/<your-fork-owner>/metagraphed/screenshots/<file>.gif`.
4. **Table format — one row per interaction target** (not per viewport/theme; a hover/scroll/transition
   effect is rarely breakpoint- or theme-dependent, so don't multiply it out the way the static matrix
   does unless the interaction genuinely differs by breakpoint):
   ```md
   ### Hover interaction (animated)

   Static images can't show the pointer-driven [behavior] — here's the actual interaction.

   | Target                                                          | Before                                                   | After                                                  |
   | --------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------ |
   | <describe the interactive element, e.g. "Blocks · author cell"> | [<img src="BEFORE_GIF_URL" width="380">](BEFORE_GIF_URL) | [<img src="AFTER_GIF_URL" width="380">](AFTER_GIF_URL) |
   ```
   One row per distinct interactive element the PR changes.
5. A PURELY interaction-only change (identical at-rest state, only the triggered behavior changed) can
   skip the static matrix for that specific view — state why in one sentence, the same "provably
   unaffected" exception already allowed for a static viewport/theme combo.

### Phase C3 — Test + gates locally

The `ui` CI job runs lint, typecheck, test, a responsive-overflow e2e check, build, and a
bundle-size-budget check, in that order — run the same locally before pushing:

```sh
npm run lint --workspace=apps/ui && npm run format:check --workspace=apps/ui
npm run typecheck --workspace=apps/ui  # auto-builds packages/client first (pretypecheck) -- no separate step needed
npm test --workspace=apps/ui
npm run test:e2e --workspace=apps/ui   # needs a Chromium browser: npx playwright install --with-deps chromium (once)
npm run build --workspace=apps/ui
```

The responsive-overflow e2e check replays recorded API traffic (`tests/e2e/har/*.har`)
instead of live production data, so it's deterministic regardless of live chain state. If
your PR adds a new API call on one of the checked routes (`/`, `/subnets/1`,
`/endpoints`, `/status`, `/settings`, `/explorer`), re-record:
`npm run test:e2e:record-har --workspace=apps/ui` against a running dev server.

CI also gzip-measures the initial client JS for a cold `/` visit against a budget (currently ~300 KB,
`.github/workflows/validate.yml`'s "Bundle size budget" step) — keep new dependencies/imports lean; if
a real feature legitimately grows it, raise the budget deliberately in the same PR. If your PR also
touches `packages/client` or `packages/ui-kit`, CI rebuilds each fresh and diffs against its committed
`dist` (`packages/client/dist` / `packages/ui-kit/dist`) — run `npm run build --workspace=packages/client`
(or `--workspace=packages/ui-kit`) and commit the result if you changed `packages/client/src` (or
`packages/ui-kit/src`). `packages/ui-kit` also gets its own `npm run typecheck --workspace=packages/ui-kit`
step in the `ui` CI job.

### Phase C4 — Commit + PR

Conventional Commit (e.g. `feat(ui): add validator directory table`), no AI attribution, `Closes
#<issue>` — required, and the issue must still be open. Fill the screenshot table if the change is visual.

### Phase C5 — Review disposition

**Any visual PR touching `apps/ui/` is always held for manual review**, regardless of AI-review
confidence — this is a deliberate exception to the normal one-shot autonomous gate. A non-visual
`apps/ui/` PR (data/hooks/tests only) follows the normal auto-merge/auto-close gate like Path A/B.

---

## Final pre-push checklist

**Path A (surface):**

- [ ] Exactly one `registry/subnets/<slug>.json` changed; existing manifests only append community
      surface(s), while missing manifests may include the required `subnet:new` scaffold plus the
      community surface(s); no other file.
- [ ] Each surface: real public `url` + a proving `source_url`; right `kind`; `authority: community`;
      `review.state: community-submitted`; `public_safe: true`; no health/`verification`/secrets set by hand.
- [ ] Not a duplicate of an existing surface or an open PR; not the same surface re-titled by `kind`.
- [ ] `npm run validate:surface` + `npm run scan:public-safety` clean.
- [ ] If you ran `npm run build` locally out of caution (not normally required for Path A), your diff
      still touches only your one subnet file — see the Path B note below on
      `public/metagraph/r2-manifest.json` / `public/metagraph/schemas/index.json`; the Gittensory Gate's
      registry-review lane rejects a PR that bundles either in with your surface change.
- [ ] Conventional Commit (no AI attribution); PR template filled; **`Closes #<issue>`** — required, referencing an issue that's still open.

**Path B (code/schema):**

- [ ] In scope, narrow, anchored on ≥2 analogues; general not special-cased.
- [ ] Regenerated + committed: `npm run build` artifacts (OpenAPI/types/contracts) as applicable. MCP
      tool additions do NOT require server-card regen (worker-computed). Client version bump NOT required
      (auto-sync workflow handles it post-merge).
- [ ] `public/metagraph/r2-manifest.json` and `public/metagraph/schemas/index.json` are **not** part of
      your diff — both always change on a local/CI build for reasons unrelated to your PR (they're
      deploy/publish-pipeline-owned, not contract artifacts). Revert them against your base remote
      (the Phase B3 command above) before committing if `npm run build` touched them. `npm run build`
      itself warns you if either changed.
- [ ] `git diff --check` clean · `lint` + `format:check` + `typecheck` clean · `npm run validate` green ·
      `npm run test:coverage` green · the focused `validate:*` for what you touched green.
- [ ] Branch current with `main`; Conventional Commit (no AI attribution); PR template filled; `Closes #<issue>` — required, referencing an issue that's still open.

**Path C (frontend):**

- [ ] Scoped to `apps/ui/**` only; ≤10 files / ≤1000 LOC where reasonably possible.
- [ ] Reuses existing design tokens (`apps/ui/src/styles.css`) and shared components rather than
      one-off styling.
- [ ] If visual: a filled before/after screenshot table (mobile + dark-mode captures where relevant) —
      missing/malformed table is an automatic close.
- [ ] If the change is only visible in motion (hover/scroll/transition/animation): a before/after GIF
      table alongside the static one, per the "Animated evidence" step in Phase C2.
- [ ] `lint` + `format:check` + `typecheck` + `test` + `test:e2e` + `build` all green
      (`--workspace=apps/ui`); bundle size still under budget.
- [ ] If `packages/client/src` or `packages/ui-kit/src` changed: rebuilt and committed the respective
      `dist` (`packages/client/dist` / `packages/ui-kit/dist`).
- [ ] Conventional Commit (no AI attribution); `Closes #<issue>` — required, referencing an issue that's still open.

If every box is checked, the PR has the best chance of a one-shot approve-and-merge. If any box can't
be checked, **keep working — don't push.**

---

When you need the exhaustive detail behind any phase, read **`reference.md`** in this skill directory.
