# The chain-state poller, as a Cloudflare Container (#9146).
#
# SAME BINARY, NEW HOME. apps/indexer-rs/Dockerfile builds both targets and
# ships `poller` already, but its CMD is backfill-rs's entrypoint -- on the box
# the poller was selected by the Ansible role's `command:`, not by the image.
# There is no role any more, so this image exists to make `poller` the command.
#
# WHY A CONTAINER RATHER THAN A REWRITE. The three jobs this runs
# (metagraph, subnet-hyperparams, account-identity) hold no Postgres client:
# each POSTs to an existing Worker sync route, and those routes now persist to
# D1. So the producer needs no code change at all -- it is the same binary that
# has written these rows for months. The alternative was hand-writing a
# MetagraphInfo SCALE decoder in the Worker, which would have to reproduce two
# columns that are not on chain (`rank` has no storage item in dTAO; `trust` is
# a constant 0) and get alpha-vs-TAO denomination right, with no way to verify
# any of it once the box it would be checked against is gone.
#
# Build context is apps/indexer-rs/ (see wrangler.jsonc's containers entry), so
# the COPY paths below are relative to that crate, matching its own Dockerfile.
FROM rust:1-bookworm AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
# --locked so the image cannot silently resolve a different dependency tree
# than the box-built binary this replaces.
RUN cargo build --release --locked --bin poller

FROM debian:bookworm-slim
# ca-certificates: subxt uses rustls and the sync routes are HTTPS, so without
# these every chain connection and every POST fails at TLS.
#
# curl is NOT optional. metagraph.rs's post_sync shells out to it via
# tokio::process::Command (piping the body through stdin rather than argv, so a
# 30k-row payload never hits an arg-length limit) instead of pulling in an HTTP
# client crate -- the same reason apps/indexer-rs/Dockerfile installs it.
# Without it the job does all its chain work, resolves every subnet, and then
# dies at the last step with "spawn curl: No such file or directory", which
# looks like a network fault rather than a missing binary. Caught by running
# this image against production, not by reading it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/target/release/poller /app/poller

# METAGRAPH ONLY, and the narrowness is the point.
#
# Three poller jobs are Postgres-free (metagraph, subnet-hyperparams,
# account-identity), but only ONE of them still has readers: as of #9145,
# METAGRAPH_SUBNET_HYPERPARAMS_SOURCE and METAGRAPH_ACCOUNT_IDENTITY_SOURCE are
# "retired", so those routes serve a schema-stable empty by decision. Running
# their jobs here would burn chain reads writing rows nothing will ever read,
# and would imply a liveness the API no longer claims.
#
# METAGRAPH_NEURONS_SOURCE is "d1" -- live, read through DATA_API's D1 twin
# (#9160/#9165). That is the one lane still needing a producer.
#
# Set in the image rather than left to the deployment: main.rs only skips its
# DATABASE_URL requirement when every enabled job is Postgres-free, so an
# override that adds a Postgres-backed job fails loudly at startup instead of
# running a job with nowhere to write.
ENV POLLER_ONLY=metagraph
# The public archive endpoint. The private fullnode the box used is gone.
ENV EVENTS_RPC_URL=wss://archive.chain.opentensor.ai:443

CMD ["/app/poller"]
