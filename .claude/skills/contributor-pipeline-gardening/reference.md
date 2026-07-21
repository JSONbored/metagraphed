# Contributor pipeline gardening — reference (metagraphed)

## Scope boundary — registry enrichment is a separate automation (see SKILL.md)

Don't file, triage, or fix anything under `registry/subnets/*.json` from this pipeline — not just the
Enrich-SNxx new-subnet-intake family, but registry data work of any kind (accuracy passes,
probe-config gaps, curation fields, etc). See SKILL.md's "Scope boundary" section for the 2026-07-19
incident that established this.

This is about not _authoring_ registry content, not about ignoring issue-state hygiene for an issue
whose deliverable happens to touch `registry/`. The MCP execute "verify + wire SN*" family is the
one exception where Pass 1's normal stale-sweep verification still applies — see SKILL.md's dedicated
subsection under Pass 1 and the milestone-table row below.

## Docs architecture migration — RESOLVED 2026-07-16, fully shipped

metagraphed's website docs migrated off hand-built TanStack Router route files (one full React
component per page — the old `docs.*.tsx` pattern) onto a shared MDX pipeline. **#6225** (the port
issue, filed 2026-07-16 after loopover's own spike/rollout — JSONbored/loopover#6037 + #6271) closed
the same day as **superseded**: the pipeline shipped via a native `fumadocs-mdx` + `fumadocs-ui` +
`fumadocs-openapi` integration (not the originally-proposed Scalar `@scalar/api-reference`) — content
now lives in `content/docs/*.mdx` behind a single `docs.$.tsx` catch-all route, and the API-reference
half is generated straight from `openapi.json` via `fumadocs-openapi` (#6210) rather than an embedded
Scalar component.

**All 10 previously-paused "Docs page: X" issues (#3504-#3511, #3514, #3516) plus the earlier
#3512/#3513/#3515 are written and closed (#6232).** This family is fully drained — don't look here
for Pass 2 top-up material, and don't re-open or re-triage any of these issues; they're done.

## Product shape

metagraphed is a Bittensor subnet registry + block-explorer product: `registry/subnets/<slug>.json`
(one file per subnet, community-contributed surfaces), a Worker API (`workers/`, OpenAPI-schema-driven,
`schemas/` is the contract), and `apps/ui` (the explorer frontend). See `.claude/skills/metagraphed/`
for the full contribution model — that skill is authoritative for how a PR gets merged here; this
skill only covers issue-pipeline hygiene, not PR review mechanics.

## Milestone taxonomy (re-check every run — this repo's hygiene and counts drift faster than gittensory's)

| Milestone                                     | Open (as of 2026-07-15)                                                                  | Nature                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Foundations & Infra` (#11)                   | ~27+ (growing — see below)                                                               | General backend/infra work, mixed maintainer/contributor. Also the default home for well-precedented REST/GraphQL/MCP parity issues (no dedicated milestone exists for that pattern yet).                                                                                                                                                                                    |
| `Wave 4 — Docs & Dev Surface` (#10)           | ~21                                                                                      | Docs pages for shipped API surfaces — mostly currently `maintainer-only` but low-risk to unlock, see SKILL.md. Paused pending the fumadocs-mdx port issue #6225 (filed 2026-07-16, loopover's own spike #6037 already landed) — don't unlock the "Docs page: X" family until #6225 lands.                                                                                    |
| `Partner Flywheel Hardening` (#13)            | ~4                                                                                       | Small, check individually                                                                                                                                                                                                                                                                                                                                                    |
| `Wave 3 — Frontend (post-consolidation)` (#9) | 11 (checked 2026-07-15 — NOT drained, an earlier "0/480" snapshot of this doc was stale) | Verify its real open count fresh each run rather than trusting a cached number here                                                                                                                                                                                                                                                                                          |
| Unmilestoned                                  | ~23 (checked 2026-07-15)                                                                 | Mostly legitimate: the Enrich-SNxx rolling-intake family + the bot-managed Dependency Dashboard, both correctly standalone. Verify what's actually unmilestoned fresh each run before assuming it's a hygiene gap — an earlier "~74, real gap" snapshot of this doc was stale.                                                                                               |
| `MCP Platform — Unified Subnet Access`        | ~120 issues at creation, count drops as they close/reopen                                | The "MCP execute: verify + wire SN\*" family (#7017-#7136) — already fully filed, one per subnet, don't generate more. See SKILL.md's dedicated subsection under Pass 1 for the special stale-sweep rule (test-only-PR anti-pattern, full-API-parity completeness bar) — this family needs different verification handling than a normal code issue, not different sourcing. |

**Every gardening-generated issue gets a milestone — none ship unmilestoned** (reinforced by the
maintainer, 2026-07-15). Default to the closest-fitting existing one from the table above. A new
milestone is warranted only when nothing existing fits AND the work is either a genuinely major
initiative or a recurring category that will keep needing a home — see gittensory/loopover's own
`reference.md` for the `Miner Wave 4.5` precedent of the latter case. A one-off oddity alone isn't
enough justification; when genuinely unsure on a high-stakes call like this, propose 1-2 options, but
default to deciding and documenting the reasoning rather than blocking a run on confirmation.

## Labels — this repo's own convention, don't force gittensory's onto it

- `gittensor:bug` (0.05x), `gittensor:feature` (0.25x), `gittensor:priority` (1.5x) — same point
  values as gittensory, **but `gittensor:priority` is used far more liberally here** (roughly a third
  of all open issues, often standalone with no `gittensor:feature`/`gittensor:bug` pairing). Follow
  this repo's existing density, don't artificially scarce it down to match gittensory.
- `help wanted` — paired with points labels, same as gittensory.
- `backend` / `frontend` — apply when the work is clearly one or the other; skip when it's genuinely
  both or neither (e.g. a pure docs/data issue).
- `maintainer-only` — used on ~57% of open issues (81/142). Only ~14 of those also carry `roadmap`,
  so **don't assume the `roadmap`+`maintainer-only` pairing convention from gittensory applies here**
  — in this repo `maintainer-only` alone is a complete, sufficient signal.
- `good first issue` is **not** a real convention here — the label doesn't exist in this repo
  (confirmed 2026-07-14) and the maintainer doesn't want it added. Only `gittensor:*` + `help wanted`
  (+ `backend`/`frontend` where clearly applicable) matter for contributor-available issues.
- Never add anything beyond the above to a gardening-generated issue.

## What's safe to unleash

Same underlying test as gittensory's copy of this skill (clear precedent to follow, no business/product
decision required, doesn't touch security-sensitive surfaces without a maintainer design pass first,
doesn't require access a contributor can't have). metagraphed-specific instances of the boundary:

- **Docs pages for already-shipped API endpoints** (the Wave 4 "Docs page: X" family) — writing
  accurate docs for an existing, stable endpoint is mechanical and low-risk. Good unlock candidates.
- **Native-staking feature work** (real stake movement, commission/take management, re-delegation,
  the pre-launch security review, phishing-resistance/subdomain work) — stays `maintainer-only`.
  This is live financial functionality; don't unlock any of it without an explicit ask.
- **Registry/surface data contributions** are a distinct category from code issues — they're the
  community's main contribution path (one file per subnet) and don't need the same
  maintainer-vs-contributor gating a code change does, since the gate's own AI-reviewer +
  ownership-proof verification is the real safety net there, not issue labeling.

## Reuse-existing-pattern is mandatory, not implied, whenever a real precedent exists

Maintainer's own words, 2026-07-21: "gittensor miners are lazy and don't care, so we need to be
extremely clear about what's wanted/needed." Applies here exactly as it does on gittensory/loopover's
own copy of this skill (see that repo's `reference.md` for the full incident writeup) — a contributor's
AI-harness agent reads only the issue text, not this skill file, not either repo's CLAUDE.md, and not
"the obviously right way to do it."

**What this broke on the sibling repo already:** a batch of issues had their labels flipped to
contributor-eligible, but the body text was left saying `maintainer-only` verbatim in the footer, and
one issue's Deliverables left the actual artifact ambiguous between three different plausible shapes
with no pick. Caught only because the maintainer asked for the whole body to be reread end-to-end
rather than trusting each edit in isolation.

**How to apply here:** whenever an issue's fix has a real existing precedent to follow — an existing
route/endpoint's shape, an existing schema pattern, an existing Worker handler, a comparable already-
merged PR — name the _exact_ file/PR to mirror as a leading, standalone callout (not buried in prose
Context), and state explicitly what does **not** satisfy the issue (a differently-shaped
implementation, an unspecified choice among multiple plausible artifacts, a new parallel mechanism
instead of extending the cited one). Applies to code issues under the template below; for
registry/surface-data issues, the equivalent is naming the exact sibling subnet file whose surface
shape/format should be mirrored, per `.claude/skills/metagraphed/reference.md`'s own conventions.

Before publishing any batch, reread each finished issue body end-to-end — not just the diff of what
changed — to catch exactly this class of self-contradiction.

## Issue body template

```md
## Context

<what exists today, cite real file/schema/route paths, why this matters>

## Requirements

<concrete, testable requirements>

## Deliverables

- [ ] <concrete artifact 1>
- [ ] <concrete artifact 2>

## Expected Outcome

<what's true after this ships that wasn't true before>

## Links & Resources

<related issues, files to anchor on>
```

For a registry/surface-data issue (asking a contributor to add a subnet's surfaces), follow the
surface-contribution shape in `.claude/skills/metagraphed/reference.md` instead — do not use the
code-issue template above for that kind of ask.

## Native relationship linking (GraphQL — confirmed available on this repo, 2026-07-14)

**Check every new batch of issues for a real dependency before moving on — required, not optional**
(reinforced by the maintainer, 2026-07-15). Most batches of independent bug-fixes or parity additions
(e.g. a set of REST/GraphQL-mirror issues, each adding one unrelated field) genuinely have no
dependency on each other — the correct outcome of the check is then "no links needed." Reserve
`addBlockedBy` for a real case where working an issue out of order would waste a contributor's time,
and `addSubIssue` for anything genuinely part of a parent epic/tracker.

```graphql
mutation {
  addSubIssue(
    input: { issueId: "<parent node id>", subIssueId: "<child node id>" }
  ) {
    issue {
      number
    }
  }
}
mutation {
  addBlockedBy(
    input: {
      issueId: "<blocked node id>"
      blockingIssueId: "<blocker node id>"
    }
  ) {
    issue {
      number
    }
  }
}
```

**Field name gotcha:** the mutation's second input field is `blockingIssueId`, not `blockedById` —
`blockedById` fails with `argumentNotAccepted`. Confirmed live 2026-07-16 linking #3504-3511/3514/3516
as blocked by #6225.

Get a node ID: `gh api graphql -f query='query { repository(owner:"JSONbored", name:"metagraphed") { issue(number: N) { id } } }'`.

## gh CLI gotchas

- `gh api graphql -f query=@file.txt` does **not** read the file — `-f` treats `@file` as a literal
  string and the request fails with a GraphQL parse error on the `@`. Use **`-F query=@file.txt`**
  (capital F) whenever the query is large enough to be worth writing to a file first.
- `gh issue close` has no `--comment-file` flag — write the comment to a file, then pass
  `-c "$(cat file.md)"` (double-quoted around the whole substitution) so any backticks in the comment
  text are treated as literal characters, not re-parsed by bash as command substitution.
- Never embed a body/comment string containing backticks directly inside a `python3 -c "..."`
  double-quoted bash argument for the same reason — write it to a file first.
