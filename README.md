<div align="center">

<a href="https://metagraph.sh"><img src="https://raw.githubusercontent.com/JSONbored/metagraphed/main/public/brand/banner-readme-mint.png" alt="Metagraphed — Bittensor subnet operational layer · data hub · API" width="820"></a>

### Every subnet, metagraphed.

The Bittensor subnet integration registry. For every subnet it answers: **what does it expose** (public APIs, docs, schemas), **is it healthy**, and **how do I call it** — machine-readable, for AI agents and developers alike.

[![Website](https://img.shields.io/badge/website-metagraph.sh-111?logo=cloudflare&logoColor=white)](https://metagraph.sh)
[![MCP](https://img.shields.io/badge/MCP-api.metagraph.sh%2Fmcp-7c3aed)](https://api.metagraph.sh/mcp)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-listed-7c3aed)](https://registry.modelcontextprotocol.io/v0/servers?search=metagraphed)
[![mcp.so](https://img.shields.io/badge/mcp.so-listed-f97316)](https://mcp.so/server/metagraphed---bittensor-subnet-registry/JSONbored)
[![smithery badge](https://smithery.ai/badge/metagraphed/metagraphed)](https://smithery.ai/servers/metagraphed/metagraphed)
[![npm](https://img.shields.io/npm/v/@jsonbored/metagraphed?logo=npm&label=npm)](https://www.npmjs.com/package/@jsonbored/metagraphed)
[![PyPI](https://img.shields.io/pypi/v/metagraphed?logo=pypi&logoColor=white&label=PyPI)](https://pypi.org/project/metagraphed/)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)
[![Gittensor impact](https://api.gittensor.io/repos/JSONbored%2Fmetagraphed/badge.svg)](https://gittensor.io/miners/repository?name=JSONbored/metagraphed)

**[Website](https://metagraph.sh)** &nbsp;·&nbsp; [API](https://api.metagraph.sh) &nbsp;·&nbsp; [OpenAPI](https://api.metagraph.sh/metagraph/openapi.json) &nbsp;·&nbsp; [GraphQL](https://api.metagraph.sh/api/v1/graphql) &nbsp;·&nbsp; [MCP](https://api.metagraph.sh/mcp) &nbsp;·&nbsp; [Agent docs](https://api.metagraph.sh/llms.txt) &nbsp;·&nbsp; [Agent workflows](https://api.metagraph.sh/agent-workflows.md) &nbsp;·&nbsp; [Feeds](https://api.metagraph.sh/api/v1/feeds/registry) &nbsp;·&nbsp; [npm](https://www.npmjs.com/package/@jsonbored/metagraphed) &nbsp;·&nbsp; [PyPI](https://pypi.org/project/metagraphed/)

</div>

---

## What it is

The native Bittensor metagraph tells you what's happening at the protocol layer. Metagraphed adds the **builder-facing layer it lacks** — a registry of public subnet interfaces, endpoint health, and machine-readable schemas, built for **integration developers** (often reached through their AI agents) who need to discover and call subnet APIs.

> **Not** an official OpenTensor/Bittensor project · **not** a replacement for the native metagraph · **not** an alpha/price dashboard · **not** a wallet, validator, or credential tool.

The web UI lives at **[metagraph.sh](https://metagraph.sh)**. The API is served from **`https://api.metagraph.sh`** (REST under `/api/v1`, artifacts under `/metagraph`).

## Quickstart

Three ways to use Metagraphed. Pick one.

#### 🤖 AI agent (MCP)

Agent-native, public, read-only, Streamable-HTTP. 26 tools to discover a subnet, check if it's up, read its economics and metagraph, trace what a wallet does across the network, and learn how to call it.

```bash
claude mcp add --transport http metagraphed https://api.metagraph.sh/mcp
```

> Cursor / other clients: add an MCP server with url `https://api.metagraph.sh/mcp`, transport `streamable-http`.
>
> Tools: `search_subnets` · `list_subnets` · `find_subnets_by_capability` · `get_subnet` · `get_subnet_health` · `get_subnet_economics` · `get_subnet_trajectory` · `get_subnet_metagraph` · `list_subnet_validators` · `get_neuron` · `get_account` · `get_account_events` · `get_account_subnets` · `list_subnet_apis` · `get_api_schema` · `get_fixture` · `get_agent_catalog` · `get_best_rpc_endpoint` · `registry_summary` · `list_enrichment_targets` · `find_subnet_opportunities` · `semantic_search` · `ask` · `find_subnet_for_task` · `how_do_i_call` · `verify_integration`

#### 📦 Typed client

Generated from the OpenAPI contract, published with provenance.

```bash
npm i @jsonbored/metagraphed   # JS/TS
pip install metagraphed        # Python
```

#### 🌐 REST

Stable JSON envelope `{ ok, data, meta, error }`. OpenAPI at [`/metagraph/openapi.json`](https://api.metagraph.sh/metagraph/openapi.json).

```bash
curl https://api.metagraph.sh/api/v1/subnets
```

#### 🔮 GraphQL

Shape one request across the registry — a subnet with its health, surfaces, endpoints, and economics, a provider with its subnets, or the economic opportunity boards. `POST` to [`/api/v1/graphql`](https://api.metagraph.sh/api/v1/graphql); `GET` returns the SDL and introspection is enabled.

```bash
curl -X POST https://api.metagraph.sh/api/v1/graphql \
  -H 'content-type: application/json' \
  -d '{"query":"{ subnet(netuid: 7) { name health { status } surfaces { kind url } economics { emission_share } } }"}'
```

## For agents

| Resource              | URL                                                                                                                                                                                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Copyable agent prompt | [`/agent.md`](https://api.metagraph.sh/agent.md)                                                                                                                                                                                                                                   |
| Agent workflows       | [`/agent-workflows.md`](https://api.metagraph.sh/agent-workflows.md)                                                                                                                                                                                                               |
| Machine index         | [`/llms.txt`](https://api.metagraph.sh/llms.txt)                                                                                                                                                                                                                                   |
| GraphQL               | [`/api/v1/graphql`](https://api.metagraph.sh/api/v1/graphql) — POST a shaped query (subnet + health + surfaces + endpoints + economics, provider + subnets, opportunity boards); GET returns the SDL                                                                               |
| Drop-in skill         | [`/skills/bittensor/SKILL.md`](https://api.metagraph.sh/skills/bittensor/SKILL.md)                                                                                                                                                                                                 |
| Resources index       | [`/metagraph/agent-resources.json`](https://api.metagraph.sh/metagraph/agent-resources.json)                                                                                                                                                                                       |
| Content feeds         | [`/api/v1/feeds/registry`](https://api.metagraph.sh/api/v1/feeds/registry) — registry changes + incidents, as RSS / Atom / JSON Feed; [`/api/v1/feeds/gaps`](https://api.metagraph.sh/api/v1/feeds/gaps) for ranked coverage gaps (per-subnet at `/api/v1/feeds/subnets/{netuid}`) |
| Embeddable badge      | `![metagraphed](https://api.metagraph.sh/api/v1/subnets/{netuid}/badge.svg)` — SVG (also `/providers/{slug}/badge.svg`); `?metric=uptime` for reliability, `?metric=completeness` for coverage score, plus `?style=flat-square` and `?label=…`                                     |

## This repo

Cloudflare Worker API + Node build scripts. **Schema-first**: JSON Schema is the canonical contract → OpenAPI → types/clients. Artifacts are deterministic JSON; data refreshes on a schedule to R2/KV.

```text
docs/              product + operating notes (start here)
registry/          subnet overlays, candidates, community submissions
schemas/           canonical JSON Schema components
scripts/           validation, generation, probe, safety
workers/           Cloudflare Worker API routes
public/metagraph/  compact generated artifacts + contracts
generated/         generated TypeScript types + client
```

Deeper docs: [`docs/api-stability.md`](docs/api-stability.md) (the `/api/v1` contract), [`docs/curation-playbook.md`](docs/curation-playbook.md).

## Contributing

Open the repo in a [devcontainer](.devcontainer/devcontainer.json)-aware tool (VS Code, GitHub Codespaces, the `devcontainer` CLI) for a zero-setup environment — Node 22 + Playwright's Chromium preinstalled. Issues are labeled `good first issue` and `help wanted` — start there.

- **Schema-first edits** require `npm run build` (regenerates `openapi.json` + types).
- **Community submissions** are PR-first: add a surface to exactly one `registry/subnets/<slug>.json` file (via `npm run surface:add`; use `npm run subnet:new` first when that subnet has no file yet), no generated artifacts.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`docs/curation-playbook.md`](docs/curation-playbook.md).

### Gittensor contributor impact

<p align="center">
  <a href="https://gittensor.io/miners/repository?name=JSONbored/metagraphed">
    <img src="https://raw.githubusercontent.com/JSONbored/metagraphed/gittensor-impact-assets/gittensor-impact-dark.svg" alt="Gittensor contributor impact" width="600">
  </a>
</p>

Refreshed weekly by [`.github/workflows/gittensor-impact.yml`](.github/workflows/gittensor-impact.yml).

## Subnet catalog

<!-- BEGIN:REGISTRY-CATALOG -->

**129 curated subnets** — 118 with a site, 47 with docs, 118 with a public repo. Live health, search, and the full list (every active subnet, not just the curated ones) at **[metagraph.sh](https://metagraph.sh)**; per-subnet JSON at `https://api.metagraph.sh/api/v1/subnets/{netuid}`.

**Focus areas:** `compute` 9 · `data` 7 · `defi` 7 · `inference` 5 · `language-models` 4 · `computer-vision` 3 · `finance` 3 · `dashboard` 2 · `data-artifact` 2 · `decentralized-training` 2 · `depin` 2 · `distributed-training` 2

- **[root](https://metagraph.sh/subnets/0)** `SN0` — `chain-rpc` · [site](https://bittensor.com) · [docs](https://docs.learnbittensor.org/concepts/bittensor-networks) · [repo](https://github.com/opentensor/subtensor)
- **[Apex](https://metagraph.sh/subnets/1)** `SN1` · [site](https://apex.macrocosmos.ai/) · [docs](https://docs.macrocosmos.ai/subnets/subnet-1-apex) · [repo](https://github.com/macrocosm-os/apex)
- **[DSperse](https://metagraph.sh/subnets/2)** `SN2` — `verifiable-oracles` `zkml` · [site](https://subnet2.inferencelabs.com/) · [docs](https://sn2-docs.inferencelabs.com/) · [repo](https://github.com/inference-labs-inc/subnet-2)
- **[Templar](https://metagraph.sh/subnets/3)** `SN3` — `decentralized-training` `tournament` · [site](https://www.tplr.ai/) · [docs](https://docs.tplr.ai/) · [repo](https://github.com/one-covenant/templar)
- **[Targon](https://metagraph.sh/subnets/4)** `SN4` · [site](https://targon.com/) · [docs](https://docs.targon.com/) · [repo](https://github.com/manifold-inc/targon)
- **[Hone](https://metagraph.sh/subnets/5)** `SN5` · [site](https://www.hone.training/) · [repo](https://github.com/manifold-inc/hone)
- **[Numinous](https://metagraph.sh/subnets/6)** `SN6` — `forecasting` `openapi` `subnet-api` · [site](https://numinouslabs.io/) · [docs](https://api.numinouslabs.io/api/docs) · [repo](https://github.com/numinouslabs/numinous)
- **[Allways](https://metagraph.sh/subnets/7)** `SN7` — `bitcoin` `defi` `subnet-api` · [site](https://all-ways.io/) · [docs](https://docs.all-ways.io/how-it-works.html) · [repo](https://github.com/entrius/allways)
- **[Vanta](https://metagraph.sh/subnets/8)** `SN8` · [site](https://www.vantanetwork.io/) · [repo](https://github.com/taoshidev/vanta-network)
- **[iota](https://metagraph.sh/subnets/9)** `SN9` · [site](https://iota.macrocosmos.ai/) · [repo](https://github.com/macrocosm-os/iota)
- **[Swap](https://metagraph.sh/subnets/10)** `SN10` · [site](https://www.taofi.com/pool) · [docs](https://docs.taofi.com/) · [repo](https://github.com/Swap-Subnet/swap-subnet)
- **[TrajectoryRL](https://metagraph.sh/subnets/11)** `SN11` · [site](https://trajrl.com/) · [docs](https://trajrl.com/docs) · [repo](https://github.com/trajectoryRL/trajectoryRL)
- **[Compute Horde](https://metagraph.sh/subnets/12)** `SN12` — `compute` `dashboard` · [site](https://computehorde.io/) · [repo](https://github.com/backend-developers-ltd/ComputeHorde)
- **[Data Universe](https://metagraph.sh/subnets/13)** `SN13` — `data` `mcp` · [site](https://datauniverse.macrocosmos.ai/) · [docs](https://docs.macrocosmos.ai/product-and-services/gravity) · [repo](https://github.com/macrocosm-os/data-universe)
- **[Cacheon](https://metagraph.sh/subnets/14)** `SN14` — `inference` · [site](https://cacheon.ai/) · [docs](https://cacheon.ai/docs) · [repo](https://github.com/latent-to/cacheon-old)
- **[ORO](https://metagraph.sh/subnets/15)** `SN15` · [site](https://oroagents.com/) · [docs](https://docs.oroagents.com/docs/miners/quick-start) · [repo](https://github.com/ORO-AI/oro)
- **[BitAds](https://metagraph.sh/subnets/16)** `SN16` · [repo](https://github.com/study-service/BitAds.ai)
- **[404—GEN](https://metagraph.sh/subnets/17)** `SN17` — `3d-generation` · [site](https://www.404.xyz/) · [repo](https://github.com/404-Repo/404-gen-subnet)
- **[Zeus](https://metagraph.sh/subnets/18)** `SN18` — `weather-forecasting` · [site](https://www.zeussubnet.com/) · [docs](https://docs.zeussubnet.com/docs/introduction) · [repo](https://github.com/Orpheus-AI/Zeus)
- **[blockmachine](https://metagraph.sh/subnets/19)** `SN19` · [site](https://blockmachine.io/) · [docs](https://blockmachine.io/whitepaper) · [repo](https://github.com/taostat/blockmachine)
- **[GroundLayer](https://metagraph.sh/subnets/20)** `SN20` — `capital-markets` · [site](https://www.groundlayer.xyz/)
- **[AdTAO](https://metagraph.sh/subnets/21)** `SN21` — `advertising` · [site](https://adtao.io/) · [repo](https://github.com/ippcteam/SN21-adtao)
- **[Desearch](https://metagraph.sh/subnets/22)** `SN22` — `search` `social-data` · [site](https://www.desearch.ai/) · [docs](https://www.desearch.ai/docs) · [repo](https://github.com/Desearch-ai/subnet-22)
- **[Trishool](https://metagraph.sh/subnets/23)** `SN23` — `subnet-api-observed` · [site](https://trishool.ai/) · [repo](https://github.com/TrishoolAI/trishool-phase2)
- **[Quasar](https://metagraph.sh/subnets/24)** `SN24` — `language-models` `model-artifacts` · [site](https://silxinc.com/) · [docs](https://github.com/SILX-LABS/QUASAR-SUBNET/blob/main/README.md) · [repo](https://github.com/SILX-LABS/QUASAR-SUBNET)
- **[Mainframe](https://metagraph.sh/subnets/25)** `SN25` — `compute` · [site](https://macrocosmos.ai/sn25) · [repo](https://github.com/macrocosm-os/mainframe)
- **[Perturb](https://metagraph.sh/subnets/26)** `SN26` — `adversarial-robustness` `computer-vision` · [site](https://www.perturbai.io/) · [docs](https://www.perturbai.io/whitepaper) · [repo](https://github.com/0xsigurd/Perturb)
- **[NI Compute](https://metagraph.sh/subnets/27)** `SN27` — `compute` `dashboard`
- **[gm](https://metagraph.sh/subnets/28)** `SN28` — `llm-inference` `marketplace` `tee` · [site](https://saygm.com/) · [repo](https://github.com/taostat/gm-miner)
- **[Coldint](https://metagraph.sh/subnets/29)** `SN29` — `data` `distributed-training` · [site](https://coldint.io/) · [docs](https://github.com/coldint/coldint_validator/blob/main/README.md) · [repo](https://github.com/coldint/coldint_validator)
- **[Endure Network](https://metagraph.sh/subnets/30)** `SN30` — `defi` `risk-intelligence` · [site](https://endure.network/) · [docs](https://docs.endure.network/)
- **[Recall](https://metagraph.sh/subnets/31)** `SN31` — `rag` `retrieval`
- **[ItsAI](https://metagraph.sh/subnets/32)** `SN32` · [site](https://its-ai.org/en) · [repo](https://github.com/It-s-AI/llm-detection)
- **[ReadyAI](https://metagraph.sh/subnets/33)** `SN33` — `conversation-data` `data` · [site](https://readyai.ai/) · [docs](https://github.com/afterpartyai/bittensor-conversation-genome-project/blob/main/README.md) · [repo](https://github.com/afterpartyai/bittensor-conversation-genome-project)
- **[BitMind](https://metagraph.sh/subnets/34)** `SN34` — `deepfake-detection` · [site](https://bitmind.ai/) · [docs](https://docs.bitmind.ai/) · [repo](https://github.com/BitMind-AI/bitmind-subnet)
- **[OxMarkets](https://metagraph.sh/subnets/35)** `SN35` — `defi` · [site](https://www.0xmarkets.io/) · [repo](https://github.com/General-Tao-Ventures/cartha-validator)
- **[Eirel](https://metagraph.sh/subnets/36)** `SN36` — `llm-evaluation` · [site](https://eirel.ai/) · [repo](https://github.com/RendixNetwork/eirel-ai)
- **[Aurelius](https://metagraph.sh/subnets/37)** `SN37` — `alignment` · [site](https://aureliusaligned.ai/) · [repo](https://github.com/Aurelius-Protocol/Aurelius-Protocol)
- **[ChronoLLM](https://metagraph.sh/subnets/38)** `SN38` — `language-models` · [site](https://chronollm.com/) · [docs](https://github.com/chronollm/sn38/blob/main/docs/miner.md) · [repo](https://github.com/chronollm/sn38)
- **[Basilica](https://metagraph.sh/subnets/39)** `SN39` — `compute` · [site](https://www.basilica.ai/) · [repo](https://github.com/one-covenant/basilica)
- **[Ralph](https://metagraph.sh/subnets/40)** `SN40` — `distributed-training` `language-models` · [site](https://www.ralphlabs.ai/) · [docs](https://github.com/RalphLabsAI/ralph/blob/main/docs/Ralph-Whitepaper-v1.3.pdf) · [repo](https://github.com/RalphLabsAI/ralph)
- **[Almanac](https://metagraph.sh/subnets/41)** `SN41` — `prediction-markets` · [site](https://almanac.market/) · [repo](https://github.com/sportstensor/sn41)
- **[Gopher](https://metagraph.sh/subnets/42)** `SN42` — `data` `tee` · [site](https://developers.gopher-ai.com/) · [docs](https://developers.gopher-ai.com/docs/subnet/intro) · [repo](https://github.com/gopher-lab/subnet-42)
- **[Graphite](https://metagraph.sh/subnets/43)** `SN43` — `optimization` `research` · [site](https://graphite-ai.net/) · [repo](https://github.com/GraphiteAI/Graphite-Subnet)
- **[Score](https://metagraph.sh/subnets/44)** `SN44` — `computer-vision` · [site](https://www.wearescore.com/) · [repo](https://github.com/score-technologies/turbovision)
- **[AlphaRidge.ai](https://metagraph.sh/subnets/45)** `SN45` — `market-intelligence` `sentiment-analysis` · [site](https://ai.talisman.xyz/) · [repo](https://github.com/Team-Rizzo/alpharidge-ai)
- **[Zipcode](https://metagraph.sh/subnets/46)** `SN46` — `real-estate` · [site](https://zipcode.ai/) · [repo](https://github.com/resi-labs-ai/RESI-models)
- **[EvolAI](https://metagraph.sh/subnets/47)** `SN47` — `data` · [site](https://evolai.ai/) · [repo](https://github.com/openevolai/evolai)
- **[Quantum Compute](https://metagraph.sh/subnets/48)** `SN48` — `compute` `quantum` · [site](https://www.qbittensorlabs.com/) · [repo](https://github.com/qbittensor-labs/quantum-compute)
- **[Nepher Robotics](https://metagraph.sh/subnets/49)** `SN49` — `robotics` `tournament` · [site](https://nepher.ai) · [docs](https://docs.nepher.ai/) · [repo](https://github.com/nepher-ai/nepher-subnet)
- **[Synth](https://metagraph.sh/subnets/50)** `SN50` — `finance` · [site](https://synthdata.co/) · [repo](https://github.com/synthdataco/synth-subnet)
- **[lium.io](https://metagraph.sh/subnets/51)** `SN51` — `compute` · [site](https://lium.io/) · [repo](https://github.com/Datura-ai/lium-io)
- **[Dojo](https://metagraph.sh/subnets/52)** `SN52` — `tensorplex` · [site](https://www.tensorplex.ai/) · [docs](https://docs.tensorplex.ai/tensorplex-docs/tensorplex-dojo-bittensor-subnet/subnet-mechanism) · [repo](https://github.com/tensorplex-labs/dojo)
- **[EfficientFrontier](https://metagraph.sh/subnets/53)** `SN53` — `defi` `financial-trading` `trading-strategies` · [site](https://www.signalplus.com/) · [repo](https://github.com/oxylok/53-EfficientFrontier)
- **[Yanez MIID](https://metagraph.sh/subnets/54)** `SN54` — `compliance` `synthetic-data` · [site](https://www.yanez.ai/) · [repo](https://github.com/yanez-compliance/MIID-subnet)
- **[NIOME](https://metagraph.sh/subnets/55)** `SN55` — `genomics` `synthetic-data` · [site](https://niome.genomes.io/) · [repo](https://github.com/genomesio/subnet-niome)
- **[Gradients](https://metagraph.sh/subnets/56)** `SN56` — `ai-training` `operational-interface` · [site](https://www.gradients.io/) · [docs](https://api.gradients.io/docs) · [repo](https://github.com/gradients-ai/G.O.D)
- **[Sparket](https://metagraph.sh/subnets/57)** `SN57` — `prediction-market` `sports` · [site](https://sparket.ai/) · [repo](https://github.com/sparket-ai/sparket-ai)
- **[Handshake58](https://metagraph.sh/subnets/58)** `SN58` — `ai-marketplace` `payments` · [site](https://handshake58.com) · [docs](https://handshake58.com/skill.md) · [repo](https://github.com/Handshake58/HS58-subnet)
- **[Babelbit](https://metagraph.sh/subnets/59)** `SN59` — `language` · [site](https://babelbit.ai/) · [repo](https://github.com/babelbit/babelbit_subnet)
- **[Bitsec](https://metagraph.sh/subnets/60)** `SN60` — `security` · [site](https://bitsec.ai/) · [repo](https://github.com/Bitsec-AI/sandbox)
- **[RedTeam](https://metagraph.sh/subnets/61)** `SN61` — `cybersecurity` · [site](https://www.theredteam.io/) · [docs](https://docs.theredteam.io/) · [repo](https://github.com/RedTeamSubnet/RedTeam)
- **[Ridges](https://metagraph.sh/subnets/62)** `SN62` — `agents` · [site](https://www.ridges.ai/) · [repo](https://github.com/ridgesai/ridges)
- **[Enigma](https://metagraph.sh/subnets/63)** `SN63` — `quantum` · [site](https://www.qbittensorlabs.com/) · [repo](https://github.com/qbittensor-labs/enigma)
- **[Chutes](https://metagraph.sh/subnets/64)** `SN64` — `compute` `inference` · [site](https://chutes.ai/) · [docs](https://chutes.ai/docs) · [repo](https://github.com/chutesai/chutes)
- **[TAO Private Network](https://metagraph.sh/subnets/65)** `SN65` — `networking` · [site](https://tpn.taofu.xyz/) · [repo](https://github.com/taofu-labs/tpn-subnet)
- **[ninja](https://metagraph.sh/subnets/66)** `SN66` — `software-engineering` `workflow` · [site](https://ninja66.ai/) · [docs](https://github.com/ninja-subnet/ninja/blob/main/README.md) · [repo](https://github.com/ninja-subnet/ninja)
- **[Harnyx](https://metagraph.sh/subnets/67)** `SN67` · [site](https://harnyx.ai/) · [repo](https://github.com/harnyx/harnyx)
- **[NOVA](https://metagraph.sh/subnets/68)** `SN68` · [site](https://www.metanova-labs.ai/) · [repo](https://github.com/metanova-labs/nova)
- **[ain](https://metagraph.sh/subnets/69)** `SN69` · [site](https://www.heraldmedia.ai/) · [repo](https://github.com/HeraldMedia/herald)
- **[NexisGen](https://metagraph.sh/subnets/70)** `SN70` · [site](https://nexisgen.ai/) · [repo](https://github.com/RendixNetwork/nexisgen)
- **[Leadpoet](https://metagraph.sh/subnets/71)** `SN71` · [site](https://leadpoet.com/) · [repo](https://github.com/leadpoet/leadpoet)
- **[StreetVision by NATIX](https://metagraph.sh/subnets/72)** `SN72` — `computer-vision` `data` `depin` · [site](https://www.natix.network/) · [docs](https://docs.natix.network/whitepaper) · [repo](https://github.com/natixnetwork/streetvision-subnet)
- **[MetaHash](https://metagraph.sh/subnets/73)** `SN73` — `defi` `otc` `treasury`
- **[Gittensor](https://metagraph.sh/subnets/74)** `SN74` — `developer-tools` `repositories` · [site](https://gittensor.io/) · [docs](https://docs.gittensor.io/) · [repo](https://github.com/entrius/gittensor)
- **[Hippius](https://metagraph.sh/subnets/75)** `SN75` — `depin` `storage` · [site](https://hippius.com/) · [docs](https://docs.hippius.com/) · [repo](https://github.com/thenervelab/hippius-validator)
- **[Byzantium](https://metagraph.sh/subnets/76)** `SN76` · [site](https://www.byzantiumai.net/) · [repo](https://github.com/byzantiumaitao-arch/byzantium)
- **[Liquidity](https://metagraph.sh/subnets/77)** `SN77` — `defi` · [site](https://sn77.xyz/) · [repo](https://github.com/creativebuilds/sn77)
- **[Vocence](https://metagraph.sh/subnets/78)** `SN78` · [site](https://www.vocence.ai/) · [repo](https://github.com/vocence-78/vocence)
- **[MVTRX](https://metagraph.sh/subnets/79)** `SN79` · [site](https://taos.im/) · [docs](https://simulate.trading/taos-im-paper) · [repo](https://github.com/taos-im/sn-79)
- **[dogelayer](https://metagraph.sh/subnets/80)** `SN80` · [repo](https://github.com/dogelayer-ai/dogelayer)
- **[Grail](https://metagraph.sh/subnets/81)** `SN81` — `decentralized-training` · [docs](https://github.com/one-covenant/grail/tree/main/docs) · [repo](https://github.com/one-covenant/grail)
- **[Compelle](https://metagraph.sh/subnets/82)** `SN82` · [site](https://compelle.com/) · [repo](https://github.com/compelle/compelle-validator)
- **[CliqueAI](https://metagraph.sh/subnets/83)** `SN83` · [site](https://cliqueai.toptensor.ai/) · [repo](https://github.com/toptensor/CliqueAI)
- **[ansuz](https://metagraph.sh/subnets/84)** `SN84` — `chip-design` `hardware` · [site](https://www.chipforge.io/) · [docs](https://docs.chipforge.io/) · [repo](https://github.com/TatsuProject/ChipForge_SN84)
- **[Vidaio](https://metagraph.sh/subnets/85)** `SN85` · [site](https://vidaio.io/) · [repo](https://github.com/vidaio-subnet/vidaio-subnet)
- **[Subnet 86](https://metagraph.sh/subnets/86)** `SN86`
- **[Luminar Network](https://metagraph.sh/subnets/87)** `SN87` — `video-intelligence` `vision` · [site](https://luminar.network/) · [docs](https://docs.luminar.network/) · [repo](https://github.com/Luminar-Network/luminar-sn)
- **[Investing](https://metagraph.sh/subnets/88)** `SN88` — `data-artifact` `finance` · [site](https://investing88.ai/) · [repo](https://github.com/mobiusfund/investing)
- **[InfiniteHash](https://metagraph.sh/subnets/89)** `SN89` · [site](https://infinitehash.xyz/) · [docs](https://github.com/backend-developers-ltd/InfiniteHash/blob/master/docs/subnet_auction_incentive_system.md) · [repo](https://github.com/backend-developers-ltd/InfiniteHash)
- **[DegenBrain](https://metagraph.sh/subnets/90)** `SN90` — `prediction-markets` `verification` · [site](https://subnet90.com/)
- **[Bitstarter #1](https://metagraph.sh/subnets/91)** `SN91` · [site](https://bitstarter.ai/) · [repo](https://github.com/AlphaCoreBittensor/alphacore)
- **[Tensorclaw](https://metagraph.sh/subnets/92)** `SN92` — `inference` `stale-source-restored` · [site](https://www.tensorclaw.ai/) · [repo](https://github.com/tensorclaw/tensorclaw)
- **[Bitcast](https://metagraph.sh/subnets/93)** `SN93` · [site](https://www.bitcast.network/) · [repo](https://github.com/bitcast-network/bitcast)
- **[Bitsota](https://metagraph.sh/subnets/94)** `SN94` · [site](https://bitsota.ai/) · [repo](https://github.com/AlveusLabs/SN94-BitSota)
- **[Actual](https://metagraph.sh/subnets/95)** `SN95` — `inference` `model-registry` · [site](https://actual.inc/)
- **[Verathos](https://metagraph.sh/subnets/96)** `SN96` — `inference` `language-models` · [site](https://verathos.ai/) · [docs](https://verathos.ai/docs) · [repo](https://github.com/verathos-ai/verathos)
- **[Albedo](https://metagraph.sh/subnets/97)** `SN97` · [site](https://albedo.tech) · [repo](https://github.com/unarbos/albedo)
- **[ForeverMoney](https://metagraph.sh/subnets/98)** `SN98` — `finance` · [site](https://forevermoney.ai/) · [repo](https://github.com/SN98-ForeverMoney/forever-money)
- **[Leoma](https://metagraph.sh/subnets/99)** `SN99` · [site](https://leoma.ai/) · [repo](https://github.com/RendixNetwork/leoma)
- **[Plaτform](https://metagraph.sh/subnets/100)** `SN100` — `ai-research` · [site](https://www.platform.network/) · [docs](https://www.platform.network/docs) · [repo](https://github.com/PlatformNetwork/platform)
- **[eni](https://metagraph.sh/subnets/101)** `SN101` · [site](http://tag101.ai/) · [repo](https://github.com/tag101-ai/tag101)
- **[ConnitoAI](https://metagraph.sh/subnets/102)** `SN102` · [site](https://connito.ai/) · [repo](https://github.com/Connito-AI/Connito)
- **[Djinn](https://metagraph.sh/subnets/103)** `SN103` · [site](https://www.djinn.gg/) · [repo](https://github.com/Djinn-Inc/djinn)
- **[for sale (burn to uid1)](https://metagraph.sh/subnets/104)** `SN104` — `no-public-project-surface`
- **[Beam](https://metagraph.sh/subnets/105)** `SN105` · [site](https://b1m.ai/) · [repo](https://github.com/Beam-Network/beam)
- **[Nodexo](https://metagraph.sh/subnets/106)** `SN106` — `compute` `gpu` · [site](https://nodexo.ai/) · [docs](https://docs.nodexo.ai/) · [repo](https://github.com/nodexo-ai/nodexo)
- **[Minos](https://metagraph.sh/subnets/107)** `SN107` · [site](https://theminos.ai/) · [repo](https://github.com/minos-protocol/minos_subnet)
- **[TalkHead](https://metagraph.sh/subnets/108)** `SN108` · [site](https://www.talkhead.ai/) · [repo](https://github.com/talkheadai/talkhead-subnet)
- **[Academia](https://metagraph.sh/subnets/109)** `SN109` — `data-artifact` · [repo](https://github.com/fx-integral/academia)
- **[Green Compute](https://metagraph.sh/subnets/110)** `SN110` — `model-directory` · [site](https://www.green-compute.com/) · [docs](https://github.com/e35ventura/taopedia-articles/blob/main/content/pages/subnet_110/index.mdx) · [repo](https://github.com/Rich-Kids-of-TAO/rkt-subnet)
- **[oneoneone](https://metagraph.sh/subnets/111)** `SN111` — `data` `ugc` · [site](https://oneoneone.io/) · [repo](https://github.com/oneoneone-io/subnet-111)
- **[minotaur](https://metagraph.sh/subnets/112)** `SN112` · [site](https://minotaursubnet.com/) · [repo](https://github.com/subnet112/minotaur_subnet)
- **[TensorUSD](https://metagraph.sh/subnets/113)** `SN113` — `stablecoin` · [site](https://tensorusd.com/) · [docs](https://docs.tensorusd.com/components/subnet) · [repo](https://github.com/TensorUSD/subnet)
- **[SOMA](https://metagraph.sh/subnets/114)** `SN114` — `mcp` · [site](https://thesoma.ai/) · [repo](https://github.com/DendriteHQ/SOMA)
- **[HashiChain](https://metagraph.sh/subnets/115)** `SN115` · [repo](https://github.com/hashi115/hashichain)
- **[TaoLend](https://metagraph.sh/subnets/116)** `SN116` — `defi` `lending` · [site](https://taolend.io/)
- **[Glyph](https://metagraph.sh/subnets/117)** `SN117` · [site](https://glyph-research.org) · [repo](https://github.com/glyph-research/glyph-subnet)
- **[Ditto](https://metagraph.sh/subnets/118)** `SN118` — `agent-memory` · [site](https://heyditto.ai/) · [docs](https://heyditto.ai/docs/) · [repo](https://github.com/ditto-assistant/dittobench-starter-kit)
- **[Satori](https://metagraph.sh/subnets/119)** `SN119` — `virtual-world`
- **[Affine](https://metagraph.sh/subnets/120)** `SN120` · [site](https://www.affine.io/) · [repo](https://github.com/AffineFoundation/affine-cortex)
- **[sundae_bar](https://metagraph.sh/subnets/121)** `SN121` · [site](https://www.sundaebar.ai/) · [repo](https://github.com/sundae-bar/bittensor-subnet)
- **[Bitrecs](https://metagraph.sh/subnets/122)** `SN122` — `recommendations` · [site](https://www.bitrecs.ai/) · [docs](https://bitrecs.gitbook.io/bitrecs-docs/) · [repo](https://github.com/bitrecs/bitrecs-subnet)
- **[MANTIS](https://metagraph.sh/subnets/123)** `SN123` — `sdk` · [site](https://mantis123.com/) · [repo](https://github.com/Barbariandev/MANTIS)
- **[Swarm](https://metagraph.sh/subnets/124)** `SN124` — `robotics` · [site](https://swarm124.com/) · [repo](https://github.com/swarm-subnet/swarm)
- **[8 Ball](https://metagraph.sh/subnets/125)** `SN125` — `prediction-market` · [site](https://8ball125.com/) · [docs](https://github.com/Barbariandev/8Ball_miner#readme) · [repo](https://github.com/Barbariandev/8Ball_miner)
- **[Poker44](https://metagraph.sh/subnets/126)** `SN126` — `security` · [site](https://poker44.net/) · [repo](https://github.com/Poker44/Poker44-subnet)
- **[Astrid](https://metagraph.sh/subnets/127)** `SN127` — `trading-strategies` · [site](https://astrid.global/) · [repo](https://github.com/astridintelligence/sn-127)
- **[ByteLeap](https://metagraph.sh/subnets/128)** `SN128` — `compute` · [site](https://byteleap.ai/) · [repo](https://github.com/byteleapai/byteleap-Validator)

<sub>Auto-generated from the curated overlays in `registry/subnets/` by `scripts/generate-registry-readme-section.mjs` — enrich a subnet (one PR) and it appears here. Not the live list; browse + monitor everything at [metagraph.sh](https://metagraph.sh).</sub>

<!-- END:REGISTRY-CATALOG -->

## Related

- **Frontend** — [`apps/ui/`](./apps/ui) in this repo (folded in from the standalone `metagraphed-ui` repo via monorepo consolidation): the web app at [metagraph.sh](https://metagraph.sh). Vite + React 19 + TanStack Start, deployed as its own independent Cloudflare Worker. Holds no subnet data — it renders what this backend serves.

## License

The backend (Cloudflare Worker + build pipeline) is **[AGPL-3.0](./LICENSE)**. The
published client SDKs are permissively licensed so you can embed them freely —
[`packages/client`](./packages/client) (npm) and [`python/`](./python) (PyPI) are
**[Apache-2.0](./packages/client/LICENSE)**.

© 2026 JSONbored
