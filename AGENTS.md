# metagraphed — AI contributor guide

Loaded automatically by AI coding tools: **Codex** reads this `AGENTS.md`; **Claude Code** reads
`CLAUDE.md` (a symlink to this file) and additionally auto-loads the on-demand skill at
`.claude/skills/contributing-to-metagraphed/`.

**Before writing ANY contribution or pull request to this repo, read and follow the skill:**

- `.claude/skills/contributing-to-metagraphed/SKILL.md` — the one-shot-PR playbook (phases + checklist)
- `.claude/skills/contributing-to-metagraphed/reference.md` — exhaustive tables (CI, the gate, the surface schema, validators, style)

That skill is the **single source of truth** for how to contribute here. Keep it updated as the
process evolves — edits to those files improve both Claude Code and Codex.

## The five things you must not get wrong

1. **The Gittensory Gate auto-merges and auto-closes — it is not advisory.** A _contributor_ PR is
   **auto-CLOSED** on a deterministic fail (duplicate / dead `source_url` / private URL / secret), a
   clear reviewer reject, red CI, or **no linked issue**; **auto-MERGED** only when content is verified
   (owner-matched, fresh) with both AI reviewers ≥0.9, CI green, mergeable-clean, and a valid linked
   issue; **held for a human** when genuinely uncertain. Make it right before you push — recovery is a
   fresh PR.
2. **Surfaces live in ONE file per subnet.** A data contribution edits **exactly one**
   `registry/subnets/<slug>.json`, appending surface(s) with `authority: "community"` and
   `review.state: "community-submitted"` — and nothing else. **Never** add per-surface candidate
   files, **never** split a subnet's surfaces across multiple PRs, and **never** re-title the same
   surface as a different `kind` (that farm is closed — redundant PRs are auto-closed). Adding several
   surfaces for one subnet in one diff is one merge, the way it should be.
3. **Prove it and link an issue.** Every surface needs a public `url` **and** a `source_url` that
   independently proves the subnet publishes it. Every PR needs a tracked issue (`Closes #<n>`) — the
   gate hard-fails without one.
4. **Schema is the contract; regenerate + commit.** Code/schema changes: edit `schemas/`, run
   `npm run build`, commit the regenerated `openapi.json` + types/clients in the same PR, or
   `validate:contract-drift` fails CI. Never hand-edit generated artifacts under `public/`.
5. **House rules:** Conventional Commits, **no AI/Claude/agent attribution** in commits or PR text; no
   secrets / PATs / wallet paths / private URLs anywhere; health/uptime/latency is **probe-derived
   only** (never hand-set); one focused change per PR; UI/frontend work goes in
   [metagraphed-ui](https://github.com/JSONbored/metagraphed-ui), not here.

The full procedure, the gate disposition matrix, the surface schema, the validator list, and the
commit/PR rubric are all in the skill files above — use them.
