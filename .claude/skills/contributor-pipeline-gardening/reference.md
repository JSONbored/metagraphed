# Contributor pipeline gardening — reference (metagraphed)

## Product shape

metagraphed is a Bittensor subnet registry + block-explorer product: `registry/subnets/<slug>.json`
(one file per subnet, community-contributed surfaces), a Worker API (`workers/`, OpenAPI-schema-driven,
`schemas/` is the contract), and `apps/ui` (the explorer frontend). See `.claude/skills/metagraphed/`
for the full contribution model — that skill is authoritative for how a PR gets merged here; this
skill only covers issue-pipeline hygiene, not PR review mechanics.

## Milestone taxonomy (as of 2026-07-14 — re-check, this repo's hygiene drifts faster than gittensory's)

| Milestone                                     | Open                                     | Nature                                                                                                        |
| --------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `Foundations & Infra` (#11)                   | ~39-41                                   | General backend/infra work, mixed maintainer/contributor                                                      |
| `Wave 4 — Docs & Dev Surface` (#10)           | ~25                                      | Docs pages for shipped API surfaces — mostly currently `maintainer-only` but low-risk to unlock, see SKILL.md |
| `Partner Flywheel Hardening` (#13)            | ~4                                       | Small, check individually                                                                                     |
| `Wave 3 — Frontend (post-consolidation)` (#9) | 0 open / 480 closed, still marked `open` | Likely fully drained — verify and close the milestone if so, or find out why it's still open                  |
| Unmilestoned                                  | ~74 (over half of all open issues)       | Real hygiene gap — fold into the closest fit rather than leaving orphaned                                     |

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
    input: { issueId: "<blocked node id>", blockedById: "<blocker node id>" }
  ) {
    issue {
      number
    }
  }
}
```

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
