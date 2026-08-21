
FROM alpine:3.22

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

WORKDIR /config

CMD ["/app/scripts/worker.sh"]
