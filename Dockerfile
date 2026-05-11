# syntax=docker/dockerfile:1.7

FROM node:20-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:20-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Non-root user (Phala best practice)
RUN groupadd -r capbot && useradd -r -g capbot -d /app capbot \
    && chown -R capbot:capbot /app

COPY --from=deps --chown=capbot:capbot /app/node_modules ./node_modules
COPY --chown=capbot:capbot . .

USER capbot

ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=2048"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "index.js"]
