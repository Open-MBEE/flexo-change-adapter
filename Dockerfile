FROM node:24.16.0-bookworm-slim

# The pinned Debian image provides flock for excluding competing watchers.
RUN command -v flock

WORKDIR /app
COPY package.json package-lock.json ./
# Apply the same seven-day package publication cutoff as local installs.
RUN NPM_CONFIG_BEFORE="$(node -p 'new Date(Date.now() - 7 * 86400000).toISOString()')" \
    npm ci --omit=dev \
    && rm -rf /root/.npm

# Preserve all validator source/assets and lock bytes for identity agreement.
COPY src-ts/ ./src-ts/
RUN mkdir -p /data && chown node:node /data

ENV NODE_ENV=production ADAPTER_STATE_DIR=/data
USER node
ENTRYPOINT ["node", "src-ts/cli.ts"]
CMD ["run", "--config", "/configuration/adapter.json"]
