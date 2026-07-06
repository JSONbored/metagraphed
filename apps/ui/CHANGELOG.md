# Changelog

All notable changes to **metagraphed-ui** (the metagraph.sh website) are
documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

The site is continuously deployed from `main` via Cloudflare Workers Builds;
versioning and this changelog are managed by `release-please` from
[Conventional Commits](https://www.conventionalcommits.org/) touching
`apps/ui/**`, independent of the backend's release cadence.

## [0.2.0](https://github.com/JSONbored/metagraphed/compare/ui-v0.1.0...ui-v0.2.0) (2026-07-05)

### Features

- **ui:** add shared event-kind label and category map ([#3563](https://github.com/JSONbored/metagraphed/issues/3563)) ([1e6f56d](https://github.com/JSONbored/metagraphed/commit/1e6f56d77ae0f42b97222925e82068cbf839d92c)), closes [#3366](https://github.com/JSONbored/metagraphed/issues/3366)
- **ui:** add validatorsQuery and GlobalValidator types ([#3564](https://github.com/JSONbored/metagraphed/issues/3564)) ([690efb6](https://github.com/JSONbored/metagraphed/commit/690efb665e51389ffead5ce0b6c8ead947d9b7e3))

### Bug Fixes

- **client:** commit packages/client/dist -- eliminate the deploy-time build ([#3294](https://github.com/JSONbored/metagraphed/issues/3294)) ([98946ad](https://github.com/JSONbored/metagraphed/commit/98946ad9a15879d08d3d608f8abc4204e96d1cba))
- **ui:** block reserved external link hosts ([#3521](https://github.com/JSONbored/metagraphed/issues/3521)) ([6191535](https://github.com/JSONbored/metagraphed/commit/619153549dc1cc940a9ed05eaafa940ee45ce404))
- **ui:** point the omnibox/command-palette typeahead at the slim /search-index ([#3534](https://github.com/JSONbored/metagraphed/issues/3534)) ([bd20037](https://github.com/JSONbored/metagraphed/commit/bd200377c64eea274f5d7c3cb60146d5fd68df1a))

## [Unreleased]

### Added

- Public `/status` page — an overall system verdict (operational / degraded /
  partial outage) plus a recent cross-subnet incident ledger, from
  `/api/v1/health` + `/api/v1/incidents`.
- Issue templates (bug report / feature request) with a contact link routing
  data corrections to the backend repo; `CHANGELOG.md`; `FUNDING.yml`.
