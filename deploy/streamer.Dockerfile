# Realtime chain-event streamer (#1361, epic #1345) — Option B.
# A tiny always-on container for a cheap host (Oracle Cloud Free / Fly.io free
# tier, or a ~$5/mo VPS). Subscribes to finalized finney heads, decodes the
# SubtensorModule events, and POSTs them to the Worker ingest endpoint (#1360).
#
# Build (from the repo root):
#   docker build -f deploy/streamer.Dockerfile -t metagraphed-streamer .
# Run:
#   docker run -e EVENTS_INGEST_URL=https://api.metagraph.sh/api/v1/internal/events \
#              -e METAGRAPH_EVENTS_INGEST_SECRET=... metagraphed-streamer
FROM python:3.12-slim
WORKDIR /app
# Pinned (matches the CI poller) — never auto-pull a future PyPI release.
RUN pip install --no-cache-dir "substrate-interface==1.8.1"
# The streamer imports the verified decode from fetch-events.py — copy both.
COPY scripts/fetch-events.py scripts/stream-events.py /app/scripts/
ENV EVENTS_RPC_URL=wss://entrypoint-finney.opentensor.ai:443
# Provide at runtime (NOT baked in): EVENTS_INGEST_URL, METAGRAPH_EVENTS_INGEST_SECRET
CMD ["python", "scripts/stream-events.py"]
