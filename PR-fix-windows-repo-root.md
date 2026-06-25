# PR: fix(scripts): use fileURLToPath for repoRoot to fix Windows path mangling

**Branch:** `fix/windows-repo-root` → `main`
**Template:** backend-code

---

## Summary

- Runtime-only one-liner fix: `scripts/lib.mjs` now derives `repoRoot` via
  `fileURLToPath(new URL("..", import.meta.url))` instead of
  `new URL("..", import.meta.url).pathname`.
- On Windows, `.pathname` returns a leading-slash, drive-prefixed string
  (`/E:/work/metagraphed/`) that `path.join` then doubles the drive into
  `E:\E:\work\...`, silently breaking every local artifact read and test run
  for any contributor on Windows.
- `fileURLToPath` returns a correct native path on all platforms (Linux/macOS
  behaviour is unchanged).
- No schema, contract, or generated artifact changes — this is a pure scripts
  fix.

## What Changed

- `scripts/lib.mjs`: add `import { fileURLToPath } from "node:url"`, swap
  `repoRoot` assignment from `.pathname` to `fileURLToPath(...)`.

## Registry Safety

- [x] No secrets, PATs, wallet data, private dashboards, private URLs, or
      validator-local state.
- [x] Generated artifacts were produced by repo scripts, not hand-edited.
- [x] R2-only/high-churn detail artifacts are not committed.
- [x] Public API/OpenAPI/schema changes are intentional and documented.

## Validation

- [x] `git diff --check`
- [x] `npm run validate`
- [x] `npm run scan:public-safety`
