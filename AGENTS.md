# metagraphed — AI contributor guide

Loaded automatically by AI coding tools: **Codex** reads this `AGENTS.md`; **Claude Code** reads
`CLAUDE.md` (a symlink to this file) and additionally auto-loads the on-demand `metagraphed` skill at
`.claude/skills/metagraphed/`.

**Before writing ANY contribution or pull request to this repo, read and follow the skill:**

- `.claude/skills/metagraphed/SKILL.md` — the one-shot-PR playbook (phases + checklist)
- `.claude/skills/metagraphed/reference.md` — exhaustive tables (CI, the gate, the surface schema, validators, style)

That skill is the **single source of truth** for how to contribute here. Keep it updated as the
process evolves — edits to those files improve both Claude Code and Codex.

## The five things you must not get wrong

1. **The Gittensory Gate auto-merges and auto-closes — it is not advisory.** A _contributor_ PR is
   **auto-CLOSED** on a deterministic fail (duplicate / dead `source_url` / private URL / secret), a
   clear reviewer reject, or red CI; **auto-MERGED** only when content is verified (owner-matched,
   fresh) with both AI reviewers ≥0.9, CI green, and mergeable-clean; **held for a human** when
   genuinely uncertain. Make it right before you push — recovery is a fresh PR.
2. **Surfaces live in ONE file per subnet.** A data contribution edits **exactly one**
   `registry/subnets/<slug>.json`, appending surface(s) with `authority: "community"` and
   `review.state: "community-submitted"` — and nothing else. **Never** add per-surface candidate
   files, **never** split a subnet's surfaces across multiple PRs, and **never** re-title the same
   surface as a different `kind` (that farm is closed — redundant PRs are auto-closed). Adding several
   surfaces for one subnet in one diff is one merge, the way it should be.
3. **Prove it.** Every surface needs a public `url` **and** a `source_url` that independently proves
   the subnet publishes it. A linked issue is **required** — reference it (`Closes #<n>`) and the
   issue must be **open/unclosed** at the time the PR is submitted; the gate verifies the PR against
   the linked issue's intent, clause by clause. A PR with no linked issue, or one linked to an issue
   that's already closed, is auto-closed on that basis alone.
4. **Schema is the contract; regenerate + commit.** Code/schema changes: edit `schemas/`, run
   `npm run build`, commit the regenerated `openapi.json` + generated types in the same PR, or
   `validate:contract-drift` fails CI. Never hand-edit generated artifacts under `public/`. Do **not**
   bump `packages/client/package.json` in your PR — the `sync-client-version` workflow handles that
   post-merge. Likewise, do **not** hand-bump `MCP_SERVER_VERSION` (`src/mcp-server.mjs`) or
   `server.json`'s `"version"` — `sync-mcp-version` bumps both automatically after a tool-registry
   change lands on main. MCP tool additions do **not** require a server-card regen (it's
   worker-computed). **99% patch coverage, branch-counted** — `codecov/patch` enforces
   `target: 99%, threshold: 0%` on every changed line and branch in `src/**`/`workers/**`; measure it
   unsharded with `npm run test:coverage`.
5. **House rules:** Conventional Commits, **no AI/Claude/agent attribution** in commits or PR text; no
   secrets / PATs / wallet paths / private URLs anywhere; health/uptime/latency is **probe-derived
   only** (never hand-set); one focused change per PR. **UI/frontend work now lives in this repo**
   at `apps/ui/` (folded in from the former `metagraphed-ui` repo via monorepo consolidation,
   2026-07) — any PR touching visual output (routes, components, styles) **requires a before/after
   screenshot table and is always held for manual review**, regardless of AI-review confidence; a
   PR confined to `apps/ui/src/lib/**` / `apps/ui/src/hooks/**` / tests (no visual change) follows
   the normal gate.

The full procedure, the gate disposition matrix, the surface schema, the validator list, and the
commit/PR rubric are all in the skill files above — use them.
