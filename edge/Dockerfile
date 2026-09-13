# HashSucker edge proxy — prebuilt Caddy with the repo's routing contract.
#
# Single-purpose image so pulled deployments need no repo files: the
# Caddyfile is baked in at build time. Runtime port still comes from
# $EDGE_PORT (Caddy {$VAR} expansion) with compose defaults.

FROM caddy:2-alpine

# Release provenance (build args; never secrets — labels only).
ARG REVISION=unknown
ARG VERSION=dev

COPY Caddyfile /etc/caddy/Caddyfile

LABEL org.opencontainers.image.title="HashSucker edge" \
      org.opencontainers.image.source="https://github.com/peedubyah/hashsucker" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.version="${VERSION}"
