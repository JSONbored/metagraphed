---
description: Discover testnet↔mainnet subnet lineage from repo configs and open a PR for review (pass --dry-run to report only)
argument-hint: "[--dry-run]"
allowed-tools: Bash, Read, Edit, Write, Glob, Grep
---

# Testnet ↔ mainnet lineage discovery

Bittensor subnet teams routinely run a testnet equivalent and **document its netuid in
their repo config**. This finds those documented testnet netuids by reading each mainnet
subnet's GitHub repo, then proposes new/updated lineage links in `registry/lineage.json`
via a pull request for maintainer review. **Never merge** — the PR merge is the approval.

Arguments: `$ARGUMENTS` — if it contains `--dry-run`, do everything EXCEPT the branch/commit/PR
(print the report and stop).

## Inputs (already in this repo)

- `registry/native/finney-subnets.json` — mainnet subnets; some have `chain_identity.github_repo`.
- `registry/native/test-subnets.json` — the authoritative list of testnet netuids that exist now.
- `registry/lineage.json` — existing links `{ mainnet_netuid, testnet_netuid, matched_by, review_state, reviewed_at, notes }`. Build only ever surfaces `review_state: "maintainer-approved"`; `matched_by` must be `github_repo` or `chain_name`.

## Method

1. Load all three files. Collect: mainnet subnets that HAVE a `chain_identity.github_repo`; the set of existing `(mainnet_netuid → testnet_netuid)` pairs; and the set of testnet netuids that currently exist.
2. For each mainnet subnet with a repo `OWNER/NAME`, read its config and look for a documented testnet netuid. Fetch from the repo's **default** branch (a default branch named `test` is itself a strong testnet signal):

   ```bash
   gh api "repos/OWNER/NAME" --jq .default_branch
   gh api "repos/OWNER/NAME/contents/FILE?ref=BRANCH" --jq .content | base64 -d
   ```

   Check whichever of these exist: `.env.example`, `.env.sample`, `constants.py`, `**/constants.py`, `config.py`, `README.md`, `docker-compose*.yml`. Look for patterns like `NETUID=<mainnet> # <testnet> if using testnet`, `NETUID_TEST`, `TESTNET_NETUID`, `test_netuid`, or a comment pairing a netuid with "testnet". **Record the exact evidence line + the file.** Tolerate 404s / missing files — skip and count.

3. Validate each discovered `(mainnet → testnet)` pair:
   - The testnet netuid MUST exist in `test-subnets.json` (else discard — don't link a dead subnet).
   - Skip pairs already in `lineage.json`.
4. Check EXISTING links for drift: flag any whose `testnet_netuid` no longer exists in `test-subnets.json` (likely deregistered/recycled), and any whose mainnet repo now documents a DIFFERENT testnet netuid than recorded. **Do not auto-edit these** — list them for the maintainer.

## Report

Print a summary: repos scanned, new validated links (with mainnet/testnet netuids + names + the exact evidence line), drifted existing links, and a count of repos with no documented testnet netuid.

**If `--dry-run` was passed, stop here.**

## Open the PR (only when not --dry-run, and only if there are new links or drift)

1. Branch: `claude/lineage-discovery-$(date -u +%Y-%m-%d)`.
2. Append each NEW link to `registry/lineage.json` `links[]`:

   ```json
   {
     "mainnet_netuid": M,
     "testnet_netuid": T,
     "matched_by": "github_repo",
     "review_state": "maintainer-approved",
     "reviewed_at": "<date -u +%Y-%m-%dT00:00:00.000Z>",
     "notes": "<MainnetName> SN<M> ↔ testnet <T> (<testnet on-chain name>). Documented in OWNER/NAME <file>: '<exact evidence line>'. Repo-config evidence for maintainer review, not proof."
   }
   ```

   For drifted existing links, leave them in place and describe them in the PR body only.

3. Regenerate the committed artifact: `npm ci` then `npm run build`. Then commit **only** `registry/lineage.json` and `public/metagraph/lineage.json`. Revert EVERY other changed file with `git checkout -- <path>` — the build also rewrites unrelated machine-data files (`datasets/*`, `llms*.txt`, `subnets.json`, `coverage.json`, `r2-manifest.json`, `agent-*.json`, …); **never commit those**.
4. Verify `npm run validate:schemas` passes. If it fails, fix the JSON and re-run.
5. Open a PR (do **not** merge): `gh pr create --title "chore(lineage): weekly testnet↔mainnet discovery ($(date -u +%Y-%m-%d))"`. The body MUST list, per proposed link, the mainnet/testnet netuids + names + the exact evidence line so a maintainer can verify before merging; plus a drifted-links section and a "scanned N repos, X had no documented testnet netuid" summary.

## Hard rules

- NEVER merge the PR or push to `main`; only the `claude/*` branch.
- Commit ONLY `registry/lineage.json` + `public/metagraph/lineage.json`. Never the other rebuilt files.
- Repo self-declared netuids are evidence for review, not authority — record them in the notes and let the maintainer approve by merging.
- Time-box to ~15 minutes: if you can't scan every repo, process what you can, note "not scanned this run: <list>" in the PR body, and exit cleanly so the next run resumes.
