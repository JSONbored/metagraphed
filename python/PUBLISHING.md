# Publishing `metagraphed` to PyPI

Releases go out via **OIDC Trusted Publishing** — no API token is ever created
or stored. The `.github/workflows/publish-python.yml` workflow builds the wheel +
sdist in an unprivileged job and publishes from a separate privileged job, so no
third-party code runs while the OIDC token is live.

## One-time bootstrap (owner, no placeholder upload needed)

1. **Confirm the project name is free** at <https://pypi.org/project/metagraphed/>
   (a 404 means available). If it's taken, change `[project].name` in
   `python/pyproject.toml`, the `pip install` command in the README, and the
   PyPI Project Name field below to e.g. `metagraphed-client`.

2. **Add a PyPI pending publisher** at
   <https://pypi.org/manage/account/publishing/> → "Add a new pending publisher"
   with EXACTLY:
   - PyPI Project Name: `metagraphed`
   - Owner: `JSONbored`
   - Repository name: `metagraphed`
   - Workflow name: `publish-python.yml`
   - Environment name: `pypi-production`

3. **Create the GitHub Environment** in repo Settings → Environments → New
   environment named EXACTLY `pypi-production` (optionally add required reviewers
   for a manual approval gate before each publish).

That's it — no token, no bootstrap upload. The pending publisher converts to a
normal Trusted Publisher on the first successful publish.

## Cutting a release

1. Bump `[project].version` in `python/pyproject.toml` (strict semver, no `v`
   prefix) on `main`.
2. Actions → **Publish Python SDK** → Run workflow.

The release gate (`scripts/validate-python-release.sh`) refuses to run off
`main`, requires strict semver, and aborts if the git tag `python-v<version>` or
the PyPI version already exists.
