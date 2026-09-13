FROM node:24-alpine AS ui-build

WORKDIR /build/ui

# Release provenance (build args; never secrets — labels only).
ARG REVISION=unknown
ARG VERSION=dev

COPY ui/package.json ui/package-lock.json ./
RUN npm ci

COPY ui/ ./
# @api alias resolves to ../src/api relative to UI root (see ui/vite.config.js).
# In this stage WORKDIR is /build/ui, so target is /build/src/api.
COPY src/api/ /build/src/api/

RUN npm run build


FROM node:24-alpine

WORKDIR /app

# Release provenance args (re-declared: ARGs are stage-scoped).
ARG REVISION=unknown
ARG VERSION=dev

# su-exec: drop from the entrypoint's root (bind-ownership repair) to
# the non-root runtime user. No other tooling added to the image.
RUN apk add --no-cache su-exec

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    REQUESTS_ROOT=/requests \
    DISCOVERY_DB=/data/discovery-cache.db \
    CONTROL_PLANE_DB=/data/control-plane.db \
    STATIC_ROOT=/app/public

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src/ ./src/
COPY --from=ui-build /build/ui/dist/ ./public/

LABEL org.opencontainers.image.title="HashSucker media-search" \
      org.opencontainers.image.source="https://github.com/peedubyah/hashsucker" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.version="${VERSION}"

# Create data dirs and install the entrypoint.
# /app is owned by root but node only needs read access for serving.
# Host bind mounts override /data /requests /strm ownership at runtime;
# the entrypoint (starting as root) repairs ownership where the runtime
# user cannot write, then drops to node — so first boot on root-owned
# fresh binds (and Unraid nobody:users trees) just works.
RUN mkdir -p /data /requests \
 && chown -R node:node /data /requests
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/health" >/dev/null || exit 1

ENTRYPOINT ["./entrypoint.sh"]
CMD ["npm", "start"]