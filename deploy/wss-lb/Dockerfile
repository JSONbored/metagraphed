# WSS load balancer (ADR 0013). Deployed as one SERVICE in the metagraphed-core
# Railway project, with a REPO-ROOT build context (same shape as the streamer):
#   - Source repo JSONbored/metagraphed, branch main, auto-deploy on push
#   - Service > Settings > Config-as-code "Railway Config File" = /deploy/wss-lb/railway.json
#     (the config path is absolute from the repo root; it does NOT follow Root Directory)
#   - Leave Root Directory unset → build context is the repo root, so these COPYs
#     are written relative to it.
# Local:  docker build -f deploy/wss-lb/Dockerfile -t metagraphed-wss-lb .
FROM node:22.23.1-alpine
WORKDIR /app
COPY deploy/wss-lb/package.json deploy/wss-lb/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY deploy/wss-lb/src ./src
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "src/server.mjs"]
