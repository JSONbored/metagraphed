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
  candidate files, never split across multiple PRs. Invoke for any "contribute to / open a PR
  against / enrich a subnet in / add a surface to / fix a bug in metagraphed" task.
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

---

## Two kinds of contribution — pick your path

| You are…                                                                                                      | Path                                             | Files you touch                                                                 |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------- |
| **Adding or enriching a subnet's public surfaces** (API, OpenAPI, docs, repo, dashboard, SDK, data artifact…) | **Path A — Surface contribution** (Phases A0–A5) | **exactly one** `registry/subnets/<slug>.json`                                  |
| **Changing code, schemas, or build scripts** (Worker API, `schemas/`, `scripts/`, workflows)                  | **Path B — Code/schema PR** (Phases B0–B5)       | `src/`, `workers/`, `schemas/`, `scripts/`, `.github/`, + regenerated artifacts |

Most contributions are **Path A**. Do **not** mix the two in one PR.

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
6. **Link an issue when one exists (optional).** A linked issue is **not required** — a PR with no
   linked issue is judged on its own merit and is **never** closed for the missing link. When an issue
   does track the work, reference it (`Closes #<n>` / `Refs #<n>`) in the PR body and the gate verifies
   the PR against that issue's intent. For surface work, the per-subnet enrichment issues under
   [epic #427](https://github.com/JSONbored/metagraphed/issues/427) are the natural home to link.
7. **Schema is the contract — regenerate + commit (Path B).** Editing `schemas/` means
   `npm run build` then committing `openapi.json` + types/clients in the same PR, or
   `validate:contract-drift` fails CI.
8. **Conventional Commits, no AI attribution.** Lowercase scope, specific subject, no trailing period;
   **no AI/Claude/agent mention** anywhere in commits or PR text. Keep UI/frontend work out of this
   repo — it lives in [metagraphed-ui](https://github.com/JSONbored/metagraphed-ui).

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
  # registry/providers/<slug>.json (flat — trust is the authority field) in the SAME PR:
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

You set **identity + proof + `review.state: community-submitted`** only. **Do not** add
`verification`, health, or `curation` changes, and **do not** touch other surfaces or top-level fields
in the file — a community PR that edits anything beyond appending its own community surface(s) is
out-of-shape and gets routed to full review or closed. `review.state` is the human-governance axis: a
maintainer flips it → `maintainer-reviewed` (or `rejected`) in place; machine verification + freshness
is the separate probe overlay (the build's prober fills `verification`/health).

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
  `source_url` proof, the validation commands you ran, and **`Closes #<issue>`** if an issue tracks
  this (optional — not required). No AI attribution.

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
test for every bug fix**. **Codecov is the coverage gate** — run it unsharded locally:
`npm run test:coverage`. Reader tests serve R2-only artifacts that only exist after a build, so
`npm run build` before the suite if a test reads served artifacts.

### Phase B3 — Regenerate what you invalidated (then commit it)

| You changed…                                 | Run             | Commit                                                                |
| -------------------------------------------- | --------------- | --------------------------------------------------------------------- |
| `schemas/` or `schemas/components/`          | `npm run build` | `openapi.json`, generated types, `contracts.json`, api-index          |
| A new/edited `/api/v1` route or artifact     | `npm run build` | the derived `public/metagraph/*` it produces                          |
| A canonical `registry/providers/<slug>.json` | `npm run build` | regenerated artifacts (commit only the provider file + its artifacts) |

Stale committed artifacts fail the **derived-artifact freshness** + **contract-drift** gates.

### Phase B4 — Run the gates locally (must be green)

```sh
git diff --check
npm run lint && npm run format:check        # NOTE: main isn't fully prettier-clean — never reformat whole files you didn't change
npm run validate                            # registry + API + OpenAPI checks
npm test                                    # or: npm run test:coverage for the coverage gate
# Then the focused validators for what you touched (full list in reference.md), e.g.:
npm run validate:contract-drift  npm run validate:schemas  npm run validate:api  npm run validate:openapi
```

For a faithful full local run, `npm run pipeline:check` — but only trust it in isolation **after** a
clean `npm run build` (see the build-gotchas note in `reference.md`).

### Phase B5 — Commit + PR

Conventional Commit (no AI attribution); `Closes #<issue>` if an issue tracks the work (optional); fill
the PR template with the validation commands you actually ran. Sync with `main` if it moved
(`git fetch upstream && git rebase upstream/main`) — a base conflict closes a contributor PR.

---

## Final pre-push checklist

**Path A (surface):**

- [ ] Exactly one `registry/subnets/<slug>.json` changed; only community surface(s) appended; no other file.
- [ ] Each surface: real public `url` + a proving `source_url`; right `kind`; `authority: community`;
      `review.state: community-submitted`; `public_safe: true`; no health/`verification`/secrets set by hand.
- [ ] Not a duplicate of an existing surface or an open PR; not the same surface re-titled by `kind`.
- [ ] `npm run validate:surface` + `npm run scan:public-safety` clean.
- [ ] Conventional Commit (no AI attribution); PR template filled; **`Closes #<issue>`** if an issue tracks it (optional).

**Path B (code/schema):**

- [ ] In scope, narrow, anchored on ≥2 analogues; general not special-cased.
- [ ] Regenerated + committed: `npm run build` artifacts (OpenAPI/types/contracts) as applicable.
- [ ] `git diff --check` clean · `lint` + `format:check` clean · `npm run validate` green ·
      `npm run test:coverage` green · the focused `validate:*` for what you touched green.
- [ ] Branch current with `main`; Conventional Commit (no AI attribution); PR template filled; `Closes #<issue>` if an issue tracks it (optional).

If every box is checked, the PR has the best chance of a one-shot approve-and-merge. If any box can't
be checked, **keep working — don't push.**

---

When you need the exhaustive detail behind any phase, read **`reference.md`** in this skill directory.
