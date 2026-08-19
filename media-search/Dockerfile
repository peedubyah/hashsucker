FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 REQUESTS_ROOT=/requests

COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/health" >/dev/null || exit 1
CMD ["npm", "start"]
