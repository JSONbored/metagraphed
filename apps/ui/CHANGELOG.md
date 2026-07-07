# Changelog

All notable changes to **metagraphed-ui** (the metagraph.sh website) are
documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

The site is continuously deployed from `main` via Cloudflare Workers Builds;
versioning and this changelog are managed by `release-please` from
[Conventional Commits](https://www.conventionalcommits.org/) touching
`apps/ui/**`, independent of the backend's release cadence.

## [0.3.0](https://github.com/JSONbored/metagraphed/compare/ui-v0.2.0...ui-v0.3.0) (2026-07-07)


### Features

* **ui:** add a stake-transfers summary tile to subnet economics ([#3484](https://github.com/JSONbored/metagraphed/issues/3484)) ([#3826](https://github.com/JSONbored/metagraphed/issues/3826)) ([ccf7011](https://github.com/JSONbored/metagraphed/commit/ccf70117013ab048b86099dd5110fcc5c41711c1))
* **ui:** add a weight-setters leaderboard to the subnet validators panel ([#3875](https://github.com/JSONbored/metagraphed/issues/3875)) ([da6f896](https://github.com/JSONbored/metagraphed/commit/da6f896463660f612386dea08d504493ad852dec))
* **ui:** add account endpoint-announcement activity panel ([#3860](https://github.com/JSONbored/metagraphed/issues/3860)) ([06ec91e](https://github.com/JSONbored/metagraphed/commit/06ec91e6cd68ff7a1575b88f93559279072c86ca)), closes [#3733](https://github.com/JSONbored/metagraphed/issues/3733)
* **ui:** add account hover-card variant ([#3919](https://github.com/JSONbored/metagraphed/issues/3919)) ([0b73518](https://github.com/JSONbored/metagraphed/commit/0b735180caea143598106a3b8ab53af4dec9ede3))
* **ui:** add account weight-setting activity to account detail page ([#3818](https://github.com/JSONbored/metagraphed/issues/3818)) ([700e299](https://github.com/JSONbored/metagraphed/commit/700e299590b1f1902e7a635b844eb5cd5a3d60c5))
* **ui:** add alpha-price sparkline to subnet economics panel ([#3362](https://github.com/JSONbored/metagraphed/issues/3362)) ([#3922](https://github.com/JSONbored/metagraphed/issues/3922)) ([6933817](https://github.com/JSONbored/metagraphed/commit/6933817646041cbe3644ad3e3005e44dc0088693))
* **ui:** add an aggregate weight-setting activity KPI to the subnet validators panel ([#3905](https://github.com/JSONbored/metagraphed/issues/3905)) ([ff5d9b8](https://github.com/JSONbored/metagraphed/commit/ff5d9b843a6d88ea2c8f0b2c5edc69d1c23ff486))
* **ui:** add block-production stats header to the blocks index page ([#3887](https://github.com/JSONbored/metagraphed/issues/3887)) ([da60b0b](https://github.com/JSONbored/metagraphed/commit/da60b0bc0040f0901c674880c19ac30cc154d4d0)), closes [#3488](https://github.com/JSONbored/metagraphed/issues/3488)
* **ui:** add developer settings page for webhook subscriptions ([#3494](https://github.com/JSONbored/metagraphed/issues/3494)) ([#3891](https://github.com/JSONbored/metagraphed/issues/3891)) ([59304b3](https://github.com/JSONbored/metagraphed/commit/59304b3c45ef8ce3a8d23e38ddc5c7966d24932b))
* **ui:** add foundational DownloadCsvButton CSV export ([#3402](https://github.com/JSONbored/metagraphed/issues/3402)) ([#3824](https://github.com/JSONbored/metagraphed/issues/3824)) ([4f10191](https://github.com/JSONbored/metagraphed/commit/4f10191e0c203d3272c9ca92788c37be395ca05f))
* **ui:** add network decentralization scorecard to status page ([#3823](https://github.com/JSONbored/metagraphed/issues/3823)) ([eb57bd4](https://github.com/JSONbored/metagraphed/commit/eb57bd4909f58fbd1478fe83fce851864506f7c4)), closes [#3471](https://github.com/JSONbored/metagraphed/issues/3471)
* **ui:** add network-wide stake-transfers leaderboard to explorer page ([#3906](https://github.com/JSONbored/metagraphed/issues/3906)) ([46a13ab](https://github.com/JSONbored/metagraphed/commit/46a13abb99b1e647336b19ebfb1b32bf9e44e259)), closes [#3467](https://github.com/JSONbored/metagraphed/issues/3467)
* **ui:** add raw chain-events browser to explorer page ([#3841](https://github.com/JSONbored/metagraphed/issues/3841)) ([3257d8c](https://github.com/JSONbored/metagraphed/commit/3257d8c6b8fd2a453e4388d857dff4eeea86b987))
* **ui:** add registration/deregistration counters to the subnet masthead ([#3836](https://github.com/JSONbored/metagraphed/issues/3836)) ([1892aac](https://github.com/JSONbored/metagraphed/commit/1892aacead29c341324a7dd3cb6f4534fbfd67da))
* **ui:** recognize sn&lt;netuid&gt; / netuid &lt;n&gt; shorthand in the omnibox and command palette ([#3923](https://github.com/JSONbored/metagraphed/issues/3923)) ([8b25fb7](https://github.com/JSONbored/metagraphed/commit/8b25fb7b148d6adb08f90f8ad02775911bf61c78))
* **ui:** surface account deregistration activity ([#3879](https://github.com/JSONbored/metagraphed/issues/3879)) ([8be7051](https://github.com/JSONbored/metagraphed/commit/8be7051ca6da4b295333606f83e6e72ba5594ef7)), closes [#3729](https://github.com/JSONbored/metagraphed/issues/3729)
* **ui:** surface axon-removal teardown activity in the subnet operational panel ([#3882](https://github.com/JSONbored/metagraphed/issues/3882)) ([8f39d21](https://github.com/JSONbored/metagraphed/commit/8f39d21145175202bde9380b5c9c3dc970dd264c))
* **ui:** wire Download CSV on Extrinsics page ([#3872](https://github.com/JSONbored/metagraphed/issues/3872)) ([5a8dea8](https://github.com/JSONbored/metagraphed/commit/5a8dea80959cf1ba4ec2e8ae630fbb9180a4b0ca))
* **ui:** wire Download CSV on Surfaces and Endpoints pages ([#3817](https://github.com/JSONbored/metagraphed/issues/3817)) ([3b09bc2](https://github.com/JSONbored/metagraphed/commit/3b09bc21e411227818f7bb6024e444bccd78cbd3))
* **ui:** wire semantic search into the command palette ([#3847](https://github.com/JSONbored/metagraphed/issues/3847)) ([6d40a55](https://github.com/JSONbored/metagraphed/commit/6d40a55738effed2d299deadd98feba886c9d5bc))


### Bug Fixes

* **deps:** update react monorepo to ^19.2.7 ([#3840](https://github.com/JSONbored/metagraphed/issues/3840)) ([e223fe5](https://github.com/JSONbored/metagraphed/commit/e223fe586df1e16a9af8851a16cf788ba91830c4))
* **deps:** update tanstack-router monorepo ([#3843](https://github.com/JSONbored/metagraphed/issues/3843)) ([65aa3a0](https://github.com/JSONbored/metagraphed/commit/65aa3a045f00f0fe30f1e51e4c9ce2dc4a5761d2))
* **ui:** add aria-label summaries to BarMini and Donut ([#3430](https://github.com/JSONbored/metagraphed/issues/3430)) ([#3848](https://github.com/JSONbored/metagraphed/issues/3848)) ([094c776](https://github.com/JSONbored/metagraphed/commit/094c776fe9ecb8a6479d525a64b9e7831ccab885))
* **ui:** add visible keyboard focus ring to SelectFilter and PageSizeSelect ([#3915](https://github.com/JSONbored/metagraphed/issues/3915)) ([acde989](https://github.com/JSONbored/metagraphed/commit/acde989deb89b6a290d0a66bfaf4cef28a679bc9))
* **ui:** clamp command palette width off the viewport edge on mobile ([#3869](https://github.com/JSONbored/metagraphed/issues/3869)) ([4b985fd](https://github.com/JSONbored/metagraphed/commit/4b985fd842a4b5fa0d6e1558eb782ee32d455f7b))
* **ui:** collapse multi-line union types to satisfy prettier ([0dc8968](https://github.com/JSONbored/metagraphed/commit/0dc8968233a0905f8808156797ef321aea9bcbbe))
* **ui:** collapse the NavOmnibox 'Jump to' grid to 2 columns on mobile ([#3903](https://github.com/JSONbored/metagraphed/issues/3903)) ([861aeec](https://github.com/JSONbored/metagraphed/commit/861aeec02f3b43767c0638312625eee81710b51c))
* **ui:** raise NetworkSwitcher and SettingsPopover triggers to 44px tap targets ([#3916](https://github.com/JSONbored/metagraphed/issues/3916)) ([ee3e4f1](https://github.com/JSONbored/metagraphed/commit/ee3e4f1e50cd81e2faa14a005343bcdb465bc5c0))
* **ui:** show daily-rollup freshness on the validators panel ([#3846](https://github.com/JSONbored/metagraphed/issues/3846)) ([cb1e76c](https://github.com/JSONbored/metagraphed/commit/cb1e76c6b0ec5bf2d8e8670bff9c251d28592eee)), closes [#3380](https://github.com/JSONbored/metagraphed/issues/3380)
* **ui:** surface a real error state on the account chain-events feed ([#3924](https://github.com/JSONbored/metagraphed/issues/3924)) ([b24bb96](https://github.com/JSONbored/metagraphed/commit/b24bb96118fb4a5b57e1085a00df061028105da4))
* **ui:** wire Download CSV into NeuronTable footer ([#3810](https://github.com/JSONbored/metagraphed/issues/3810)) ([6d4237c](https://github.com/JSONbored/metagraphed/commit/6d4237c5f0f21b134352d93cd8f8540fd923ae8f))


### Documentation

* **registry:** remove retired candidate lane and stale apps/ui docs ([#3926](https://github.com/JSONbored/metagraphed/issues/3926)) ([c1cdb85](https://github.com/JSONbored/metagraphed/commit/c1cdb85042c3ab8e4a56c5abba8cdf4e513c7ddc))

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
