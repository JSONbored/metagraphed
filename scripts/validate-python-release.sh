#!/usr/bin/env bash
# Gate the metagraphed PyPI release: run from main, read the version from
# python/pyproject.toml, require strict semver, and refuse if the git tag or the
# PyPI version already exists. Mirrors scripts/validate-client-release.sh.
set -euo pipefail

if [ "${GITHUB_REF:-}" != "refs/heads/main" ]; then
  echo "::error::metagraphed PyPI releases must run from main."
  exit 1
fi
if [ -z "${GITHUB_OUTPUT:-}" ]; then
  echo "::error::GITHUB_OUTPUT is required."
  exit 1
fi

release_version="$(python3 -c "import tomllib, pathlib; print(tomllib.loads(pathlib.Path('python/pyproject.toml').read_text())['project']['version'])")"
if ! printf '%s' "$release_version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "::error::python/pyproject.toml version must be strict semver without a v prefix."
  exit 1
fi

release_tag="python-v$release_version"
if git rev-parse "$release_tag" >/dev/null 2>&1; then
  echo "::error::Release tag already exists: $release_tag"
  exit 1
fi
if curl -fsS "https://pypi.org/pypi/metagraphed/$release_version/json" >/dev/null 2>&1; then
  echo "::error::PyPI version already exists: metagraphed==$release_version"
  exit 1
fi

{
  echo "version=$release_version"
  echo "tag=$release_tag"
} >>"$GITHUB_OUTPUT"
echo "Releasing metagraphed==$release_version (tag $release_tag)."
