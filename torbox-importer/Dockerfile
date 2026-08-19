

FROM alpine:latest

RUN apk add --no-cache \
    bash \
    curl \
    jq \
    aria2 \
    sqlite \
    ca-certificates \
    nano \
    coreutils

COPY scripts/ /app/scripts/
COPY claim-request.sh validate-request.sh /app/

WORKDIR /config

CMD ["sleep", "infinity"]
