---
name: contributor-pipeline-gardening
description: >-
  Daily maintenance of the contributor issue pipeline for JSONbored/metagraphed — closing issues
  that are already done but not marked so, and topping up the contributor-available backlog with
  well-scoped new issues. Invoke for "run the daily issue gardening", "audit open issues for
  stale/complete ones", "generate new contributor issues", or any recurring/scheduled run of this
  process. `reference.md` (next to this file) has the exhaustive label/milestone/template detail —
  read it before doing real work, not just this file. This is the metagraphed-specific instance;
  JSONbored/gittensory (loopover) has its own separate copy with different conventions — do not
  cross-apply either repo's specifics to the other without being asked.
---

# Contributor pipeline gardening — metagraphed

metagraphed is a Bittensor subnet registry / block-explorer product. Unlike gittensory/loopover,
**a linked issue is optional here** — the gate judges a PR on its own merit when nothing is linked,
it only auto-closes for a missing link if a linked issue was claimed and doesn't hold up (see
`.claude/skills/metagraphed/SKILL.md`). So the existential pressure to keep a full pipeline is lower
than in gittensory, but it's still the main way to (a) direct contributor effort at what actually
matters instead of ad-hoc surface PRs, and (b) hand out `gittensor:*` points fairly. Do both passes
below; treat the top-up target as "keep good, well-directed work available," not "prevent PRs from
being rejected."

## Pass 1 — stale-issue sweep (do this first, every run)

Same method as gittensory's copy of this skill (see that repo's `reference.md` if you need the full
GraphQL walkthrough) — for every open issue, query `timelineItems(itemTypes: [CROSS_REFERENCED_EVENT])`
for merged PRs that referenced it, then read the actual PR body for any hit where `willCloseTarget`
was false. Close what's genuinely done (with a comment naming the shipping PR and, ideally, a direct
grep confirming the described code/route/page exists); leave partial work open, optionally with a
scope-clarifying comment.

**metagraphed-specific things to check while doing this:**

- Milestone **#9 "Wave 3 — Frontend (post-consolidation)"** is marked `open` but currently shows 0
  open / 480 closed issues — check whether this is simply drained (in which case close the milestone
  itself) or whether it's silently missing new work that should be filed under it.
- **74 of 142 open issues (as of 2026-07-14) have no milestone at all** — a much bigger gap than
  gittensory's equivalent. Before generating new issues, spend part of a sweep folding orphaned
  issues into the milestone they actually belong to (`Foundations & Infra`, `Wave 4 — Docs & Dev
Surface`, `Partner Flywheel Hardening`, or a new one if none fit) — this repo's issue hygiene needs
  more of this than gittensory's does.
- The **native-staking feature work** (`gittensor:feature`/`maintainer-only` issues in the low-5200s
  numbering, "take/commission management," "move/re-delegate stake flow," "risk disclosure copy") is
  active and security-sensitive — treat anything touching real stake movement, phishing surface, or
  the pre-launch security review as `maintainer-only` by default; don't second-guess that boundary.

## Pass 2 — backlog top-up

1. Compute this repo's own contributor-available count (unassigned, no `maintainer-only`, carries a
   `gittensor:*` label) before deciding how much to generate here — the target is **50-100+ open
   contributor-available issues, independently per repo**. This is NOT a combined/shared pool with
   gittensory/loopover; each repo is judged on its own backlog and must clear the bar on its own
   merits, focused on that repo's actual goals (corrected by the maintainer 2026-07-14 — an earlier
   version of this doc wrongly said "combined total, not per-repo"). **Exclude the "Enrich SNxxx"
   family (see below) from this count** — it's a separately-automated queue, not this skill's backlog.
   1a. **The "Enrich SN<netuid> ..." family (tracked via #427, ~20-30 issues at any time) is handled by
   a separate automation, not this skill.** Don't count them toward the 50-100 top-up target (filter
   out any issue whose title matches "Enrich SN" before comparing against the target), and don't
   generate more of them yourselves — that automation owns that queue. Pass 1's stale-sweep/hygiene
   work (closing genuinely-done ones, fixing stale checkboxes) still applies to them like any other
   issue; the exclusion is specifically about Pass 2's top-up math (confirmed by the maintainer
   2026-07-14).
2. This repo's contributor-availability query needs `gittensor:priority` counted alongside
   `gittensor:feature`/`gittensor:bug` — unlike gittensory, metagraphed frequently uses
   `gittensor:priority` as a **standalone** points label (54 of 59 `gittensor:priority` issues here
   carry no `gittensor:feature`/`gittensor:bug` pairing, as of 2026-07-14). Don't "fix" this to match
   gittensory's scarcer convention unless asked — it's this repo's own established norm.
3. Real, concrete gaps worth scoping from first: the **"Docs page: <endpoint>" family** in
   `Wave 4 — Docs & Dev Surface` (docs for existing shipped API surfaces — `/rpc/*`, `/api/v1/search`,
   `/api/v1/webhooks/*`, etc.) are currently `maintainer-only` but look like exactly the kind of
   low-risk, precedent-following, no-business-judgment work this framework says is safe to unlock —
   worth a first-pass review to confirm and relabel rather than only generating net-new issues.
4. Every new issue: correct milestone, a `gittensor:bug`/`gittensor:feature`/`gittensor:priority`
   label (this repo's own convention — priority isn't scarce here the way it is in gittensory, but
   still means "the maintainer actually wants this soon," don't apply it reflexively to everything),
   and `help wanted` (paired convention here too). Do NOT apply `good first issue` — it isn't a real
   convention in this repo (the label doesn't exist here, confirmed 2026-07-14) and the maintainer
   doesn't want it introduced. Only `gittensor:*` + `help wanted` matter for contributor-available
   issues.
5. Full body template — Context, Requirements, Deliverables, Expected Outcome, Links & Resources (see
   `reference.md`). Registry/surface-data contributions have their own distinct shape (one file per
   subnet, `registry/subnets/<slug>.json`) — don't template a data-contribution issue the same as a
   code/schema issue; see the `metagraphed` skill's own reference.md for the surface model if
   generating that kind of issue.
6. Link relationships with GitHub's native `addSubIssue`/`addBlockedBy` mutations (same as gittensory
   — confirmed available on this repo too via the same GraphQL check) rather than a markdown checklist.
7. Quality over the number, same as gittensory's copy of this rule.

## Daily digest

Same shape as gittensory's: issues closed + why, milestones/checklists fixed, new issues filed with
milestone/label, before/after contributor-available count, anything left alone on purpose.
