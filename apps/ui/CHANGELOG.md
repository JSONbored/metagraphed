# Changelog

All notable changes to **metagraphed-ui** (the metagraph.sh website) are
documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

The site is continuously deployed from `main` via Cloudflare Workers Builds;
versioning and this changelog are managed by `release-please` from
[Conventional Commits](https://www.conventionalcommits.org/) touching
`apps/ui/**`, independent of the backend's release cadence.

## [0.4.0](https://github.com/JSONbored/metagraphed/compare/ui-v0.3.0...ui-v0.4.0) (2026-07-09)


### Features

* **devcontainer:** add contributor devcontainer + onboarding doc updates ([#4505](https://github.com/JSONbored/metagraphed/issues/4505)) ([de7325d](https://github.com/JSONbored/metagraphed/commit/de7325d39de44dfcaae02a672d0e68e6d005855b))
* **ui:** add /sudo and /admin-changes explorer pages ([#4315](https://github.com/JSONbored/metagraphed/issues/4315)) ([#4470](https://github.com/JSONbored/metagraphed/issues/4470)) ([27fdbd5](https://github.com/JSONbored/metagraphed/commit/27fdbd505247ddfa9620f54fec7188f79110ea06))
* **ui:** add /validators/$hotkey cross-subnet validator detail page ([#4338](https://github.com/JSONbored/metagraphed/issues/4338)) ([#4473](https://github.com/JSONbored/metagraphed/issues/4473)) ([f47ec2f](https://github.com/JSONbored/metagraphed/commit/f47ec2fef2d7ff5db4253fd67fb8277120abbe31))
* **ui:** add a /validators global validator directory page ([#4287](https://github.com/JSONbored/metagraphed/issues/4287)) ([faec6e6](https://github.com/JSONbored/metagraphed/commit/faec6e66133a8adaf3cf162fa4da2295612fe91e)), closes [#3358](https://github.com/JSONbored/metagraphed/issues/3358)
* **ui:** add a chain-head tip to the home hero ([#4426](https://github.com/JSONbored/metagraphed/issues/4426)) ([0f96143](https://github.com/JSONbored/metagraphed/commit/0f961432fae0a8aa0a2293d086e0e1cbc1edb485)), closes [#3372](https://github.com/JSONbored/metagraphed/issues/3372)
* **ui:** add a cross-subnet biggest-movers band to the home page ([#4378](https://github.com/JSONbored/metagraphed/issues/4378)) ([6009a14](https://github.com/JSONbored/metagraphed/commit/6009a14a59cbfb57e205fa688a94d8520a07cc7f)), closes [#3344](https://github.com/JSONbored/metagraphed/issues/3344)
* **ui:** add a Hyperparameters tab to the subnet detail page ([#4480](https://github.com/JSONbored/metagraphed/issues/4480)) ([8778cde](https://github.com/JSONbored/metagraphed/commit/8778cdec176e79d7a0618dc6e9a03f0be2746600)), closes [#4308](https://github.com/JSONbored/metagraphed/issues/4308)
* **ui:** add a network-wide stake-moves section to the chain explorer ([#4380](https://github.com/JSONbored/metagraphed/issues/4380)) ([206697e](https://github.com/JSONbored/metagraphed/commit/206697e0b26f6347b8c376c5dbad75d8fb67c057)), closes [#3468](https://github.com/JSONbored/metagraphed/issues/3468)
* **ui:** add a network-wide validator-turnover section to the chain explorer ([#4430](https://github.com/JSONbored/metagraphed/issues/4430)) ([4c71a73](https://github.com/JSONbored/metagraphed/commit/4c71a734d1564113a943f10643036faa3b73be0e)), closes [#3473](https://github.com/JSONbored/metagraphed/issues/3473)
* **ui:** add a registration-cost column to the subnets table view ([#3364](https://github.com/JSONbored/metagraphed/issues/3364)) ([#4456](https://github.com/JSONbored/metagraphed/issues/4456)) ([cf96f81](https://github.com/JSONbored/metagraphed/commit/cf96f814a9e9e07dcb695ee41405b8cfc8bb43f2))
* **ui:** add a stake-flow scorecard to the subnet Activity tab ([#4455](https://github.com/JSONbored/metagraphed/issues/4455)) ([16992a7](https://github.com/JSONbored/metagraphed/commit/16992a73db064ae89147e0efb5ef6c6f5178f67c)), closes [#3342](https://github.com/JSONbored/metagraphed/issues/3342)
* **ui:** add a validator × subnet stake heatmap to the validators page ([#4466](https://github.com/JSONbored/metagraphed/issues/4466)) ([9a8be5f](https://github.com/JSONbored/metagraphed/commit/9a8be5f1e341d8998caab6d7ab39519c3fdd2fb2)), closes [#3495](https://github.com/JSONbored/metagraphed/issues/3495)
* **ui:** add an emission-share column to the subnets table ([#4527](https://github.com/JSONbored/metagraphed/issues/4527)) ([94fa58c](https://github.com/JSONbored/metagraphed/commit/94fa58cc910275862927bef1e49cb7b4e712b069))
* **ui:** add an in-app Ask metagraphed Q&A box ([#3492](https://github.com/JSONbored/metagraphed/issues/3492)) ([#4490](https://github.com/JSONbored/metagraphed/issues/4490)) ([a3999e3](https://github.com/JSONbored/metagraphed/commit/a3999e328bdcdb2bc5e380cef9b5c97ddf1e9f99))
* **ui:** add CI responsive/overflow smoke test for apps/ui ([#4509](https://github.com/JSONbored/metagraphed/issues/4509)) ([21b8621](https://github.com/JSONbored/metagraphed/commit/21b8621ecddd38740a281095db6a172277b7bc2f))
* **ui:** add copy buttons on extrinsics hash and signer cells ([#3396](https://github.com/JSONbored/metagraphed/issues/3396)) ([#4362](https://github.com/JSONbored/metagraphed/issues/4362)) ([80b881c](https://github.com/JSONbored/metagraphed/commit/80b881c105c833eed53c580e7ba45646e86301e1))
* **ui:** add incidents feed subscribe card on status page ([#4419](https://github.com/JSONbored/metagraphed/issues/4419)) ([96f7dd5](https://github.com/JSONbored/metagraphed/commit/96f7dd526f9126b4228eb160cf13950cb9a110d9))
* **ui:** add registration-activity summary to the account detail page ([#4452](https://github.com/JSONbored/metagraphed/issues/4452)) ([595f920](https://github.com/JSONbored/metagraphed/commit/595f9209dd289f301b160f2ee3b6b043600f6f17)), closes [#3730](https://github.com/JSONbored/metagraphed/issues/3730)
* **ui:** add Share deep-link buttons to block, extrinsic, and account detail pages ([#4465](https://github.com/JSONbored/metagraphed/issues/4465)) ([26f4e97](https://github.com/JSONbored/metagraphed/commit/26f4e97984baf9614b272b3e5422a7fe02017e9e))
* **ui:** add subnet identity-change history tab to the subnet profile ([#4376](https://github.com/JSONbored/metagraphed/issues/4376)) ([12b6120](https://github.com/JSONbored/metagraphed/commit/12b6120e315953e138965195dc7b2831c327c5c6))
* **ui:** add transfer-pairs flow view to the explorer page ([#4413](https://github.com/JSONbored/metagraphed/issues/4413)) ([a49e883](https://github.com/JSONbored/metagraphed/commit/a49e883bee14be30fc4eec26c8a036dfaa3a45fa))
* **ui:** add truncation notices to the extrinsic detail page ([#4497](https://github.com/JSONbored/metagraphed/issues/4497)) ([55d3080](https://github.com/JSONbored/metagraphed/commit/55d30801e89beaf8221ea16086d6bed34c031136))
* **ui:** auto-refresh the blocks index first page ([#3374](https://github.com/JSONbored/metagraphed/issues/3374)) ([#4523](https://github.com/JSONbored/metagraphed/issues/4523)) ([92b9222](https://github.com/JSONbored/metagraphed/commit/92b92226ed27b9bb5591cddaf64e4e1fb7b09dd0))
* **ui:** display the RPC endpoints catalog on the endpoints page ([#4496](https://github.com/JSONbored/metagraphed/issues/4496)) ([76fb3a6](https://github.com/JSONbored/metagraphed/commit/76fb3a643c967c79efa291800df6b6c7a9d48d9d))
* **ui:** fetch the composed overview artifact in the subnet Overview tab ([#3346](https://github.com/JSONbored/metagraphed/issues/3346)) ([#4531](https://github.com/JSONbored/metagraphed/issues/4531)) ([0261493](https://github.com/JSONbored/metagraphed/commit/02614935d1e2376ccf3e6e9f2f3c87260784243c))
* **ui:** promote exact subnet title match to omnibox Go to ([#3394](https://github.com/JSONbored/metagraphed/issues/3394)) ([#4393](https://github.com/JSONbored/metagraphed/issues/4393)) ([4b3de7b](https://github.com/JSONbored/metagraphed/commit/4b3de7b3cb7795af83378c3af9503bdfe32ee1c2))
* **ui:** show dominance / total-stake / total-emission columns in the validator directory ([#4369](https://github.com/JSONbored/metagraphed/issues/4369)) ([6ac93c5](https://github.com/JSONbored/metagraphed/commit/6ac93c55ecb1a15e7ddb93be1a6fd22289863ae2)), closes [#3359](https://github.com/JSONbored/metagraphed/issues/3359)
* **ui:** show market-cap and FDV proxy tiles in the subnet economics panel ([#4434](https://github.com/JSONbored/metagraphed/issues/4434)) ([1fa97e2](https://github.com/JSONbored/metagraphed/commit/1fa97e27b02e58b335b9c29dc9a4f36647e067ee)), closes [#3361](https://github.com/JSONbored/metagraphed/issues/3361)
* **ui:** surface account stake-moves activity on the account detail page ([#4423](https://github.com/JSONbored/metagraphed/issues/4423)) ([d13de54](https://github.com/JSONbored/metagraphed/commit/d13de542b073e97046cb396d8b1e71a020dfa22c)), closes [#3732](https://github.com/JSONbored/metagraphed/issues/3732)
* **ui:** surface serving + prometheus endpoint-announcement tiles in the operational panel ([#4431](https://github.com/JSONbored/metagraphed/issues/4431)) ([ec8e395](https://github.com/JSONbored/metagraphed/commit/ec8e395e4f89d4943b144a90546b02b32ffdd09f))
* **ui:** wire the economics-trends time-series into an explorer trend chart ([#4547](https://github.com/JSONbored/metagraphed/issues/4547)) ([6aee4d4](https://github.com/JSONbored/metagraphed/commit/6aee4d49c079183ae6a5f2d4232ce2d420790cb4))


### Bug Fixes

* **decentralization:** disambiguate the Emission Gini tile Nakamoto hint ([#4511](https://github.com/JSONbored/metagraphed/issues/4511)) ([5b1f0bc](https://github.com/JSONbored/metagraphed/commit/5b1f0bc191c786044365ab25a584aabbb0ba4951)), closes [#3950](https://github.com/JSONbored/metagraphed/issues/3950)
* **nav:** point mega-menu "Curated" link at a real curation level ([#4508](https://github.com/JSONbored/metagraphed/issues/4508)) ([b438444](https://github.com/JSONbored/metagraphed/commit/b4384446ec40241b876db0434dccf8fd2d377e1d)), closes [#3974](https://github.com/JSONbored/metagraphed/issues/3974)
* **ui:** accept the status page's incident-stats span into the overflow baseline ([#4541](https://github.com/JSONbored/metagraphed/issues/4541)) ([c329179](https://github.com/JSONbored/metagraphed/commit/c32917911e0db07dc25dee1095433951d8963ed9))
* **ui:** align leaderboard card padding with sibling KPI/panel cards ([#4299](https://github.com/JSONbored/metagraphed/issues/4299)) ([0aa81a6](https://github.com/JSONbored/metagraphed/commit/0aa81a6fa25d3417169cba92ae401ed1c294e251))
* **ui:** auto-build packages/client before typecheck ([#4513](https://github.com/JSONbored/metagraphed/issues/4513)) ([d309772](https://github.com/JSONbored/metagraphed/commit/d30977234986a606d92f679caebd393790340bfa)), closes [#4504](https://github.com/JSONbored/metagraphed/issues/4504)
* **ui:** balance the endpoints toolbar's wrapped control row ([#4529](https://github.com/JSONbored/metagraphed/issues/4529)) ([0cfa863](https://github.com/JSONbored/metagraphed/commit/0cfa8638a7bc582262d9a39edecd72b0cb5ff57c)), closes [#3992](https://github.com/JSONbored/metagraphed/issues/3992)
* **ui:** correct stale hardcoded fallback colors for --accent/--ink-muted ([#4357](https://github.com/JSONbored/metagraphed/issues/4357)) ([7c010bb](https://github.com/JSONbored/metagraphed/commit/7c010bb8b61e1fde35d7ca03296ce9224419ce92))
* **ui:** distinguish a partial endpoint-announcement fetch failure from a real zero ([#4462](https://github.com/JSONbored/metagraphed/issues/4462)) ([1cd7e76](https://github.com/JSONbored/metagraphed/commit/1cd7e76ef123562562976e62e13b27c8200a8d6f))
* **ui:** flex-wrap the economics panel tile grid so trailing rows stretch to fill ([#4429](https://github.com/JSONbored/metagraphed/issues/4429)) ([28a76a7](https://github.com/JSONbored/metagraphed/commit/28a76a767939b76746055e6812564aa21090c999))
* **ui:** make HoverPreview keyboard-reachable for non-link evidence items ([#4461](https://github.com/JSONbored/metagraphed/issues/4461)) ([b933451](https://github.com/JSONbored/metagraphed/commit/b933451819fa1698203b50e6d99409d7f631fa1e))
* **ui:** make the responsive-overflow e2e check deterministic ([#4542](https://github.com/JSONbored/metagraphed/issues/4542)) ([2f9b0fc](https://github.com/JSONbored/metagraphed/commit/2f9b0fc055225450bee121298349069621a74459))
* **ui:** parallelize explorer's 9 suspense queries, fixing a ~33s page load ([#4518](https://github.com/JSONbored/metagraphed/issues/4518)) ([a39823a](https://github.com/JSONbored/metagraphed/commit/a39823a7c635d8231a222bea72cc9f70436d226e))
* **ui:** render uptime-timeline incident times via TimeAgo, counts via formatNumber ([#4418](https://github.com/JSONbored/metagraphed/issues/4418)) ([63bd65a](https://github.com/JSONbored/metagraphed/commit/63bd65ad29de56baed196ec5bc5820c5dc44b6e3))
* **ui:** surface error states for account extrinsics and transfers ([#3434](https://github.com/JSONbored/metagraphed/issues/3434)) ([#4408](https://github.com/JSONbored/metagraphed/issues/4408)) ([ed3672e](https://github.com/JSONbored/metagraphed/commit/ed3672e1e183c3d6861fcea686022194bf51d7da))
* **ui:** use shared EmptyState for the extrinsic emitted-events empty case ([#4433](https://github.com/JSONbored/metagraphed/issues/4433)) ([37b89db](https://github.com/JSONbored/metagraphed/commit/37b89db10d20ce1ce729efede76b650f7d62309e))
* **ui:** use significant-figure precision for the yield leaderboard so distinct validator yields stop collapsing to the same string ([#3946](https://github.com/JSONbored/metagraphed/issues/3946)) ([#4488](https://github.com/JSONbored/metagraphed/issues/4488)) ([0aced08](https://github.com/JSONbored/metagraphed/commit/0aced08c7188b16c706fade46c25e1c153f57ccd))
* **ui:** wire /health view and status params to a real validateSearch ([#4366](https://github.com/JSONbored/metagraphed/issues/4366)) ([e21146c](https://github.com/JSONbored/metagraphed/commit/e21146cd41487ba4f1622c95159e4ef243140394))


### Documentation

* note pretypecheck auto-build + missing test:e2e step ([#4521](https://github.com/JSONbored/metagraphed/issues/4521)) ([3f08d8a](https://github.com/JSONbored/metagraphed/commit/3f08d8a4d9a1dae56985202865354d00e4fa050a))

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
