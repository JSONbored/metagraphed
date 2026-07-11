# Changelog

All notable changes to **metagraphed-ui** (the metagraph.sh website) are
documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

The site is continuously deployed from `main` via Cloudflare Workers Builds;
versioning and this changelog are managed by `release-please` from
[Conventional Commits](https://www.conventionalcommits.org/) touching
`apps/ui/**`, independent of the backend's release cadence.

## [0.5.0](https://github.com/JSONbored/metagraphed/compare/ui-v0.4.0...ui-v0.5.0) (2026-07-11)


### Features

* **api,ui:** link a Multisig call to its approval chain via call_hash ([#4617](https://github.com/JSONbored/metagraphed/issues/4617)) ([c7b34c8](https://github.com/JSONbored/metagraphed/commit/c7b34c8f063b11e5edd960455703d6482a233d8f))
* **ui:** add a block-throughput sparkline to the blocks index header ([#4626](https://github.com/JSONbored/metagraphed/issues/4626)) ([852b4bc](https://github.com/JSONbored/metagraphed/commit/852b4bc06c79f36fd93939bc65e612b4877505c9))
* **ui:** add a block-time / chain-activity sparkline strip to the home page ([#4600](https://github.com/JSONbored/metagraphed/issues/4600)) ([e89b455](https://github.com/JSONbored/metagraphed/commit/e89b45537e5e3763496ec44fc04957412ea844f5))
* **ui:** add a network-wide native-TAO transfers leaderboard to the explorer page ([#4753](https://github.com/JSONbored/metagraphed/issues/4753)) ([93741aa](https://github.com/JSONbored/metagraphed/commit/93741aa3ad013312a9d5b46116d794ea32241302)), closes [#3475](https://github.com/JSONbored/metagraphed/issues/3475)
* **ui:** add a recent subnet-identity-changes widget to the homepage ([#4606](https://github.com/JSONbored/metagraphed/issues/4606)) ([d4ff487](https://github.com/JSONbored/metagraphed/commit/d4ff4877e94a9e2e788b815d827f37c916b77a89))
* **ui:** add a top-fee-payers bar chart to the explorer fees section ([#4578](https://github.com/JSONbored/metagraphed/issues/4578)) ([8417602](https://github.com/JSONbored/metagraphed/commit/84176021b597b61b1c3c0419e1156e02aa2e2230))
* **ui:** add an enrichment-targets board to the gaps review surface ([#4650](https://github.com/JSONbored/metagraphed/issues/4650)) ([4f5a23f](https://github.com/JSONbored/metagraphed/commit/4f5a23f72faa74268bc7064c34d2030a43bd3a2c))
* **ui:** add an RSS feed discovery link to the site footer ([#3351](https://github.com/JSONbored/metagraphed/issues/3351)) ([#4733](https://github.com/JSONbored/metagraphed/issues/4733)) ([ca574a8](https://github.com/JSONbored/metagraphed/commit/ca574a8df623a3978f1ae04de17550cf33dfc0d7))
* **ui:** add FeesTrendCard component to display 7-day fee trends ([#4699](https://github.com/JSONbored/metagraphed/issues/4699)) ([a972b72](https://github.com/JSONbored/metagraphed/commit/a972b72422afe7f3c9465861782e9c69a7a0d98a))
* **ui:** add network-wide deregistrations leaderboard ([#3466](https://github.com/JSONbored/metagraphed/issues/3466)) ([#4611](https://github.com/JSONbored/metagraphed/issues/4611)) ([5eeaedf](https://github.com/JSONbored/metagraphed/commit/5eeaedf925dc45cce394f765390c62742e8d203f))
* **ui:** add prev/next keyboard nav on block detail page ([#3382](https://github.com/JSONbored/metagraphed/issues/3382)) ([#4582](https://github.com/JSONbored/metagraphed/issues/4582)) ([f6f3171](https://github.com/JSONbored/metagraphed/commit/f6f3171187fcd592f00a8e3169405f2413a05d98))
* **ui:** add reusable FreshnessBadge component ([#4597](https://github.com/JSONbored/metagraphed/issues/4597)) ([4b184e6](https://github.com/JSONbored/metagraphed/commit/4b184e62927f5caacfe686c39259a84b3c1c8edf))
* **ui:** add weight-setting activity leaderboard to /leaderboards ([#4773](https://github.com/JSONbored/metagraphed/issues/4773)) ([73126a1](https://github.com/JSONbored/metagraphed/commit/73126a1aa8f5138770a8c960f88811f24314d992))
* **ui:** Alpha Holdings history chart + price-annotated stake-move table ([#4630](https://github.com/JSONbored/metagraphed/issues/4630)) ([d11c5b1](https://github.com/JSONbored/metagraphed/commit/d11c5b1a6b278e4f212613156b84ae6f04cb2703)), closes [#4333](https://github.com/JSONbored/metagraphed/issues/4333)
* **ui:** auto-refresh the extrinsics feed first page ([#3375](https://github.com/JSONbored/metagraphed/issues/3375)) ([#4620](https://github.com/JSONbored/metagraphed/issues/4620)) ([c70c620](https://github.com/JSONbored/metagraphed/commit/c70c62023ee94cd59ee706a0eade61eae4659e8b))
* **ui:** display endpoint-pools composition on endpoints page ([#3349](https://github.com/JSONbored/metagraphed/issues/3349)) ([#4660](https://github.com/JSONbored/metagraphed/issues/4660)) ([64487f3](https://github.com/JSONbored/metagraphed/commit/64487f370432fa0b5bd1b451789583ff5f20622b))
* **ui:** human-readable event-kind labels in subnet activity table ([#3367](https://github.com/JSONbored/metagraphed/issues/3367)) ([#4643](https://github.com/JSONbored/metagraphed/issues/4643)) ([2c8f2eb](https://github.com/JSONbored/metagraphed/commit/2c8f2eb5dd25eec458c325b80fa1a3258a5d4efe))
* **ui:** label account last-seen/first-indexed as near-realtime tier ([#4818](https://github.com/JSONbored/metagraphed/issues/4818)) ([eee5817](https://github.com/JSONbored/metagraphed/commit/eee58173ef9ec39b4146af26573f754698c05064))
* **ui:** network weight-setters leaderboard on chain explorer ([#3470](https://github.com/JSONbored/metagraphed/issues/3470)) ([#4680](https://github.com/JSONbored/metagraphed/issues/4680)) ([e9f2383](https://github.com/JSONbored/metagraphed/commit/e9f238330ec509ef2c9fe77faf791cce2b4d65ca))
* **ui:** recognize block#index extrinsic refs in the omnibox ([#4609](https://github.com/JSONbored/metagraphed/issues/4609)) ([4eef479](https://github.com/JSONbored/metagraphed/commit/4eef479d9d651fe54e50369609e6d03bfcdd7978)), closes [#3393](https://github.com/JSONbored/metagraphed/issues/3393)
* **ui:** render a router-level not-found page for invalid block/extrinsic refs ([#3422](https://github.com/JSONbored/metagraphed/issues/3422)) ([#4645](https://github.com/JSONbored/metagraphed/issues/4645)) ([558ca50](https://github.com/JSONbored/metagraphed/commit/558ca5072abea7566b30ee872cc8be7fdb2ea5b7))
* **ui:** render human-readable event-kind labels in the event tables ([#4735](https://github.com/JSONbored/metagraphed/issues/4735)) ([681cef2](https://github.com/JSONbored/metagraphed/commit/681cef2800cdb1365221b4843f87d6b5c352ea67)), closes [#3368](https://github.com/JSONbored/metagraphed/issues/3368)
* **ui:** show daily-rollup freshness on metagraph and neuron detail views ([#4856](https://github.com/JSONbored/metagraphed/issues/4856)) ([115fe7b](https://github.com/JSONbored/metagraphed/commit/115fe7b71de6363bb316074a2a4760f6bc0d8cb5))
* **ui:** surface a per-account stake-flow section on the account page ([#3341](https://github.com/JSONbored/metagraphed/issues/3341)) ([#4665](https://github.com/JSONbored/metagraphed/issues/4665)) ([9cbbab1](https://github.com/JSONbored/metagraphed/commit/9cbbab1ea6af301511c4eec5950af5dec40ff182))
* **ui:** trap focus in the nav mega-menu dialog + add aria-modal ([#3432](https://github.com/JSONbored/metagraphed/issues/3432)) ([#4579](https://github.com/JSONbored/metagraphed/issues/4579)) ([60a9508](https://github.com/JSONbored/metagraphed/commit/60a9508927863a35666105fc60c885501cd8def3))
* **ui:** use shared table-controls on the Providers toolbar ([#4721](https://github.com/JSONbored/metagraphed/issues/4721)) ([2a8a9fc](https://github.com/JSONbored/metagraphed/commit/2a8a9fcc29c387624b0d5afdc3807d310c43eb68))
* **ui:** wire account hover-cards onto blocks and extrinsics ss58 cells ([#4814](https://github.com/JSONbored/metagraphed/issues/4814)) ([09d0945](https://github.com/JSONbored/metagraphed/commit/09d0945fa04551fc53f7cc35eba7371e46784772))
* **ui:** wire the global review/gaps queue into the gaps review surface ([#4740](https://github.com/JSONbored/metagraphed/issues/4740)) ([96da794](https://github.com/JSONbored/metagraphed/commit/96da7946ac0b87bfb4c90ba1f2aa3372863eb9bd)), closes [#3356](https://github.com/JSONbored/metagraphed/issues/3356)
* **ui:** wire the review/enrichment-evidence queue into the gaps review surface ([#4731](https://github.com/JSONbored/metagraphed/issues/4731)) ([d46ec5e](https://github.com/JSONbored/metagraphed/commit/d46ec5e58154aa0e5d7ee2011095d0ea8599550a)), closes [#3354](https://github.com/JSONbored/metagraphed/issues/3354)


### Bug Fixes

* **blocks:** decode chain-event args (account ids -&gt; SS58) with copy affordance ([#4621](https://github.com/JSONbored/metagraphed/issues/4621)) ([6eb2c1a](https://github.com/JSONbored/metagraphed/commit/6eb2c1aed9e15dad659ca35581fa32f04408e3ef)), closes [#3984](https://github.com/JSONbored/metagraphed/issues/3984)
* **ui:** add loading + error states to AccountFootprintSection ([#3965](https://github.com/JSONbored/metagraphed/issues/3965)) ([#4662](https://github.com/JSONbored/metagraphed/issues/4662)) ([3ee6eda](https://github.com/JSONbored/metagraphed/commit/3ee6eda9318148e47410c914c3392c1fe3115ce0))
* **ui:** collapse the weight-setting KPI strip on mobile ([#3939](https://github.com/JSONbored/metagraphed/issues/3939)) ([#4799](https://github.com/JSONbored/metagraphed/issues/4799)) ([dcc61bf](https://github.com/JSONbored/metagraphed/commit/dcc61bfa9c0bf7b97dfe8608add3f8d9fcb6781d))
* **ui:** contain explorer leaderboard tables in horizontal scroll shells ([#4787](https://github.com/JSONbored/metagraphed/issues/4787)) ([7bee399](https://github.com/JSONbored/metagraphed/commit/7bee3994deca9fabdd77267f6ea99570b4863d1a)), closes [#3932](https://github.com/JSONbored/metagraphed/issues/3932)
* **ui:** distinguish loading/error/empty in About At-a-glance sidebar ([#3968](https://github.com/JSONbored/metagraphed/issues/3968)) ([#4675](https://github.com/JSONbored/metagraphed/issues/4675)) ([cbb9e9b](https://github.com/JSONbored/metagraphed/commit/cbb9e9b9263e6b004c45c3648b9e9dbe12ef164d))
* **ui:** expose selected state via ARIA on window/view toggle groups ([#3953](https://github.com/JSONbored/metagraphed/issues/3953)) ([#4806](https://github.com/JSONbored/metagraphed/issues/4806)) ([ad42028](https://github.com/JSONbored/metagraphed/commit/ad42028f625af54df5e903705c673dff6d5a5eb2))
* **ui:** extract shared statPhase helper + StatUnavailable, apply to homepage KPIs ([#3964](https://github.com/JSONbored/metagraphed/issues/3964)) ([#4756](https://github.com/JSONbored/metagraphed/issues/4756)) ([8840a48](https://github.com/JSONbored/metagraphed/commit/8840a4818c644d1521c33b806f625ac1ad189324))
* **ui:** give the network-decentralization panel a Suspense skeleton + distinct error state ([#4581](https://github.com/JSONbored/metagraphed/issues/4581)) ([b81ae9e](https://github.com/JSONbored/metagraphed/commit/b81ae9ed9fe7927c80e41fa7d052259778c73a90)), closes [#3966](https://github.com/JSONbored/metagraphed/issues/3966)
* **ui:** give the stake-transfer leaderboard a mobile card layout ([#3941](https://github.com/JSONbored/metagraphed/issues/3941)) ([#4758](https://github.com/JSONbored/metagraphed/issues/4758)) ([22a7819](https://github.com/JSONbored/metagraphed/commit/22a78191ed277ee8c6fe693ab42b1285fe8cf033))
* **ui:** interpolate live windowLabel in account activity subtitles ([#3948](https://github.com/JSONbored/metagraphed/issues/3948)) ([#4811](https://github.com/JSONbored/metagraphed/issues/4811)) ([f8749f5](https://github.com/JSONbored/metagraphed/commit/f8749f519a2b5cf22e775aeaac094339401205fe))
* **ui:** interpolate live windowLabel in subnet economics/masthead prose ([#3949](https://github.com/JSONbored/metagraphed/issues/3949)) ([#4827](https://github.com/JSONbored/metagraphed/issues/4827)) ([37857a6](https://github.com/JSONbored/metagraphed/commit/37857a6f0beea23b2acf634db880cc800f7e925b))
* **ui:** let ListShell tables scroll horizontally at tablet width ([#4739](https://github.com/JSONbored/metagraphed/issues/4739)) ([512b3d6](https://github.com/JSONbored/metagraphed/commit/512b3d68e78823b49ceabe222b7b263b74a3a6b1))
* **ui:** lift loading skeleton to bg-surface-2 for dark-mode visibility ([#3993](https://github.com/JSONbored/metagraphed/issues/3993)) ([#4828](https://github.com/JSONbored/metagraphed/issues/4828)) ([1b87007](https://github.com/JSONbored/metagraphed/commit/1b8700701a1eafdabe7d2f00bcc77ea0166cd15b))
* **ui:** make multisigCallHash/proxyRealAccount shape-agnostic ([#4669](https://github.com/JSONbored/metagraphed/issues/4669)) ([#4672](https://github.com/JSONbored/metagraphed/issues/4672)) ([bac87d1](https://github.com/JSONbored/metagraphed/commit/bac87d116b773b2b6b20e288590229bafb06efd8))
* **ui:** make the endpoint-list HeaderHint tooltip trigger keyboard-operable ([#3433](https://github.com/JSONbored/metagraphed/issues/3433)) ([#4817](https://github.com/JSONbored/metagraphed/issues/4817)) ([0db0838](https://github.com/JSONbored/metagraphed/commit/0db0838b1eadb816fc2ae4b193253f326260b4a2))
* **ui:** normalize byte-blob call args to hex, fix Ethereum.transact.input ([#4710](https://github.com/JSONbored/metagraphed/issues/4710)) ([b6a29f5](https://github.com/JSONbored/metagraphed/commit/b6a29f5b5f3927b9171b5a26b770666ff870720d))
* **ui:** prevent yield percentile strip collision at tablet width ([#4755](https://github.com/JSONbored/metagraphed/issues/4755)) ([075fd33](https://github.com/JSONbored/metagraphed/commit/075fd3397dac143af9853ae8ab934963eac07a28))
* **ui:** raise the Developer-settings header icon to the 44px tap-target standard ([#4791](https://github.com/JSONbored/metagraphed/issues/4791)) ([345143b](https://github.com/JSONbored/metagraphed/commit/345143b268fc39355c908e9afada38c500ee6c7c)), closes [#3989](https://github.com/JSONbored/metagraphed/issues/3989)
* **ui:** render indexer-rs's nested-call shape in the extrinsic detail page ([#4676](https://github.com/JSONbored/metagraphed/issues/4676)) ([b0c554c](https://github.com/JSONbored/metagraphed/commit/b0c554c94ef6023ca9ed66abdd6c76dc6c750919)), closes [#4669](https://github.com/JSONbored/metagraphed/issues/4669)
* **ui:** report extrinsic truncation totals ([#4614](https://github.com/JSONbored/metagraphed/issues/4614)) ([f5d84ba](https://github.com/JSONbored/metagraphed/commit/f5d84ba1a0aba2ab7d2e8e0b922efabafc8e66f8))
* **ui:** self-host brand fonts + design-sync setup for apps/ui ([#4870](https://github.com/JSONbored/metagraphed/issues/4870)) ([c6b6ada](https://github.com/JSONbored/metagraphed/commit/c6b6adab4ad77662392cbabf44e26b6c8e0aebd6))
* **ui:** show error state in account Balance tile on fetch failure ([#3960](https://github.com/JSONbored/metagraphed/issues/3960)) ([#4657](https://github.com/JSONbored/metagraphed/issues/4657)) ([6823cc0](https://github.com/JSONbored/metagraphed/commit/6823cc0058f8e71ba165e49cb6c167735f3168a0))
* **ui:** show error state in SubnetLineageSection on fetch failure ([#3967](https://github.com/JSONbored/metagraphed/issues/3967)) ([#4653](https://github.com/JSONbored/metagraphed/issues/4653)) ([26990e3](https://github.com/JSONbored/metagraphed/commit/26990e3243b62aa749303414ee4f09c5691e190c))
* **ui:** URL-back the /status probe-history drill-down state ([#4848](https://github.com/JSONbored/metagraphed/issues/4848)) ([29eb1f0](https://github.com/JSONbored/metagraphed/commit/29eb1f0fe4a65da0cc58c02f9539084ef0a73188)), closes [#3977](https://github.com/JSONbored/metagraphed/issues/3977)
* **ui:** use shared EmptyState for explorer section empty cases ([#3963](https://github.com/JSONbored/metagraphed/issues/3963)) ([#4742](https://github.com/JSONbored/metagraphed/issues/4742)) ([2784d4d](https://github.com/JSONbored/metagraphed/commit/2784d4d8520a5376bbe75c33001e067e722f3b62))

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
