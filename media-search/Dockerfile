FROM node:24-alpine AS ui-build

WORKDIR /build/ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci

COPY ui/ ./
COPY media-search/src/api/ /build/media-search/src/api/
RUN npm run build

FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    REQUESTS_ROOT=/requests \
    DISCOVERY_DB=/data/discovery-cache.db \
    STATIC_ROOT=/app/public

COPY --chown=node:node media-search/package.json media-search/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node media-search/src/ ./src/
COPY --chown=node:node --from=ui-build /build/ui/dist/ ./public/

RUN mkdir -p /data /requests && chown node:node /data /requests

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/health" >/dev/null || exit 1
CMD ["npm", "start"]
