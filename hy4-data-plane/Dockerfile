# HY4 south data plane -- P3 containerized build.
#
# Multi-stage:
#   1. builder  - rust:1-alpine, builds a release binary against musl
#   2. runtime  - alpine, no rust toolchain, just the binary as a non-root user
#
# Reproducible: the build context is ./hy4-data-plane. The Dockerfile expects:
#   - Cargo.toml, Cargo.lock, src/ at the build context root
#   - src/ containing lib.rs (re-exports) + serve.rs (serving core) + main.rs (binary)
#
# The build pins to rust:1-alpine (not :latest) so the build is reproducible
# on a moving release train; the Cargo.lock pins the resolved graph so the
# output is bit-stable.
#
# The runtime image has no build tooling. The binary is statically linked
# except for musl libc and libgcc_s, both of which alpine carries.

# ---- Stage 1: builder ----
FROM rust:1-alpine AS builder

WORKDIR /build

# Install only the C toolchain. The bundle ships its own SQLite via
# libsqlite3-sys 0.30.1's bundled feature (Cargo.toml), so we do NOT need
# the system sqlite3-dev. The cc crate uses cc 1.4.4 to build the
# amalgamation; the same toolchain is required here.
RUN apk add --no-cache musl-dev gcc

# Copy the manifest + lock first so dependency resolution is cached across
# rebuilds that do not touch Cargo.toml. This is the standard "small change,
# no re-resolve" layering.
COPY Cargo.toml Cargo.lock ./

# `cargo build` would resolve dependencies, but we need a placeholder src/ to
# avoid the "no targets" error. Use the real src/ from the build context.
COPY src ./src

# Release build. The Slice 4 cache is the heaviest path; --release turns on
# LTO and 3 codegen-units = 1, which is what the donor used and what the
# Slice 4.75 closure report measured.
RUN cargo build --release --bin hy4-data-plane

# ---- Stage 2: runtime ----
FROM alpine:3.20

# tini for clean signal handling (Ctrl-C, SIGTERM). The Rust binary uses
# tokio's signal handling, but a wrapper is still the convention for
# short-lived containers and matches the project's other services.
#   ca-certificates: the rust client (reqwest with rustls-tls) needs the
#   system CA bundle to talk to TorBox/Real-Debrid over HTTPS.
#   wget: matches media-search's HEALTHCHECK idiom; we use a tcp probe
#   instead (see HEALTHCHECK below) so wget is not strictly required.
RUN apk add --no-cache ca-certificates tini

# Create the data dir for the Slice 4 cache. /data must be writable by the
# non-root user. Restart/recreate preserves the cache path when this is
# mounted as a host volume (compose.yaml entry below).
RUN mkdir -p /data && \
    addgroup -S hy4 && adduser -S hy4 -G hy4 && \
    chown -R hy4:hy4 /data

USER hy4

WORKDIR /app

# Copy only the release binary. No source, no Cargo.toml, no target/.
COPY --from=builder /build/target/release/hy4-data-plane /app/hy4-data-plane

# Default config. The compose service overrides CONTROL_URL and
# CACHE_ROOT so the service reaches S-1 over the internal compose network
# and persists the cache in a named volume.
ENV LISTEN=0.0.0.0:3001 \
    CACHE_ROOT=/data/cache \
    RUST_LOG=info

EXPOSE 3001

# Liveness: TCP connect. A real HTTP probe would need a tf_id, which we do
# not have at boot -- the service is allowed to start with zero requested
# TorrentFiles. The TCP probe is the right granularity for this service.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD nc -z 127.0.0.1 3001 || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/app/hy4-data-plane"]
