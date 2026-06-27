# WSS load balancer (ADR 0013). Railway: set the service Root Directory to
# deploy/wss-lb so this build context + COPY paths resolve. Local:
#   docker build -t metagraphed-wss-lb deploy/wss-lb
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "src/server.mjs"]
