FROM node:24-alpine AS ui-build

WORKDIR /build/ui

COPY ui/package.json ui/package-lock.json ./
RUN npm ci

COPY ui/ ./
# @api alias resolves to ../src/api relative to UI root (see ui/vite.config.js).
# In this stage WORKDIR is /build/ui, so target is /build/src/api.
COPY src/api/ /build/src/api/

RUN npm run build


FROM node:24-alpine

WORKDIR /app

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

# Create data dirs and switch to non-root user.
# /app is owned by root but node only needs read access for serving.
# /data and /requests must be writable by node for runtime I/O.
RUN mkdir -p /data /requests \
 && chown -R node:node /data /requests

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/health" >/dev/null || exit 1

CMD ["npm", "start"]