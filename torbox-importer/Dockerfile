
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
    findutils

COPY scripts/ /app/scripts/
COPY claim-request.sh validate-request.sh /app/

LABEL org.opencontainers.image.title="HashSucker torbox-importer" \
      org.opencontainers.image.source="https://github.com/peedubyah/hashsucker" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.version="${VERSION}"

WORKDIR /config

CMD ["/app/scripts/worker.sh"]
