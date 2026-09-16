
FROM alpine:3.22

# Release provenance (build args; never secrets — labels only).
ARG REVISION=unknown
ARG VERSION=dev

RUN apk add --no-cache \
    bash \
    curl \
    jq \
    aria2 \
    sqlite \
    ca-certificates \
    coreutils \
    findutils \
    su-exec

COPY scripts/ /app/scripts/
COPY claim-request.sh validate-request.sh entrypoint.sh /app/
RUN chmod +x /app/entrypoint.sh

LABEL org.opencontainers.image.title="HashSucker torbox-importer" \
      org.opencontainers.image.source="https://github.com/peedubyah/hashsucker" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.version="${VERSION}"

WORKDIR /config

# Start as root so the entrypoint can repair host bind ownership, then
# drop to PUID:PGID (Unraid default 99:100). The compose `user:` stanza
# was removed for the same reason: a container that starts unprivileged
# can never repair root-created bind sources.
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["/app/scripts/worker.sh"]
