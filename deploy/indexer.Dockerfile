# Continuous chain indexer (ADR 0013 / #2110) — replaces the GitHub poller +
# streamer + */3 drain. Follows the finalized head from a durable cursor and
# writes blocks/extrinsics/account_events straight into Postgres. Co-located with
# the node + Postgres on the bare-metal box (deploy/docker-compose.yml), so RPC
# and DB hops are localhost.
#
# Build (from the repo root):
#   docker build -f deploy/indexer.Dockerfile -t metagraphed-indexer .
#
# Pinned to 3.13 (not 3.14): psycopg2-binary 2.9.10 ships cp38..cp313 wheels only
# (no cp314, no abi3, sdist-only), and python:*-slim has no C toolchain — so 3.14
# can't install it. 3.13 has wheels for every pinned dep and matches the Python
# the verified decode (fetch-events.py) was validated on.
FROM python:3.13-slim

RUN useradd --create-home --uid 10001 indexer
WORKDIR /app

# Pinned deps: the same substrate-interface as the poller/streamer (verified
# decode) + psycopg2 for the Postgres sink + redis for the cursor/heartbeat mirror.
RUN pip install --no-cache-dir \
      "substrate-interface==1.8.1" \
      "psycopg2-binary==2.9.10" \
      "redis==5.2.1"

# Reuse the verified decode (fetch-events.py) + the streamer's decode_head
# (stream-events.py) — imported, never duplicated. backfill-chain.py shares this
# image; the backfill service overrides the start command (deploy/backfill.railway.json).
COPY scripts/fetch-events.py scripts/stream-events.py scripts/index-chain.py scripts/backfill-chain.py /app/scripts/

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

USER indexer
# Provide at runtime: DATABASE_URL, EVENTS_RPC_URL, REDIS_URL (optional),
# START_BLOCK / EVENTS_WINDOW / EVENTS_MAX_LOOKBACK (optional).
CMD ["python", "scripts/index-chain.py"]
