# syntax=docker/dockerfile:1
#
# Build from the repository root:
#   docker build -f nexus/Dockerfile -t pockly-nexus .

FROM node:20-bookworm-slim AS deps

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY nexus/package.json ./nexus/package.json
RUN npm ci --omit=dev --workspace @pockly/nexus --include-workspace-root=false

FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    POCKLY_NEXUS_HOST=0.0.0.0 \
    POCKLY_NEXUS_PORT=8787 \
    POCKLY_NEXUS_DATA_DIR=/var/lib/pockly-nexus

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/nexus/node_modules ./nexus/node_modules
COPY package.json package-lock.json ./
COPY nexus ./nexus

RUN mkdir -p /var/lib/pockly-nexus \
  && chown -R node:node /var/lib/pockly-nexus /app

USER node
VOLUME ["/var/lib/pockly-nexus"]
EXPOSE 8787

CMD ["node", "nexus/bin/pockly-nexus.js", "serve", "--host", "0.0.0.0", "--port", "8787", "--data-dir", "/var/lib/pockly-nexus"]
