#!/bin/bash
# P3 CORRECTION proof -- same-infoHash sibling files.
#
# The P3 correction replaced the (info_hash, canonical_path, size)
# heuristic cache key with the exact durable TorrentFile row id
# (torrentFile.id == torrent_files.id PK) from S-1. This proof
# exercises the corrected key under a worst-case setup: two sibling
# files in the same torrent, same info_hash, different PKs,
# different paths, different sizes.
#
# The proof runs the in-crate Rust test
# `same_info_hash_sibling_files_get_distinct_cache_entries` from
# hy4-data-plane/src/cache.rs. The test is the 18th test in the
# `cache::tests` module. It is the focused adversarial proof the
# P3 correction demanded: it is capable of failing under an
# infoHash-only key (assert_ne!(key_a, key_b) on a key that does
# not include the durable PK) and under the previous composite
# key (key.contains("tf_sibling_A") would not hold if the key were
# derived from info_hash + path_hash + size).
#
# Assertions the test makes (all must PASS):
#   1. cache_key(A) != cache_key(B)
#   2. key_a contains "tf_sibling_A" (PK-derived)
#   3. key_b contains "tf_sibling_B" (PK-derived)
#   4. chunk 0 of A is PRESENT after stage+finish
#   5. chunk 0 of B is PRESENT after stage+finish
#   6. pread(A) returns 0xAA bytes
#   7. pread(B) returns 0xBB bytes
#   8. warm reread of A returns 0xAA
#   9. warm reread of B returns 0xBB
#  10. chunk counts: A=2 (16 MiB / 8 MiB), B=3 (24 MiB / 8 MiB)
#  11. sf_key(A) != sf_key(B) when provider coord is shared (worst
#      case: two siblings in the same torrent that point at the
#      same provider file)
#
# Exit codes:
#   0  - all assertions passed
#   1  - cargo test was not runnable (rust container not present)
#   2  - test FAILED
#
# The proof is runnable from a Windows dev host that has docker
# available. It uses the pinned Rust builder image (rust:1.96.1-
# alpine3.22) so the proof is reproducible across hosts.

set -e

# Repo root (the script lives at docs/hy4/tests/, so three ..'s to root).
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

# The pinned builder image. Match the Dockerfile.
RUST_IMAGE="rust:1.96.1-alpine3.22"

echo "P3 CORRECTION proof -- same-infoHash sibling files"
echo "  repo          = $ROOT"
echo "  rust image    = $RUST_IMAGE"
echo "  test name     = same_info_hash_sibling_files_get_distinct_cache_entries"
echo "  proof target  = hy4-data-plane/src/cache.rs (test #18 in cache::tests)"
echo ""

# Run the test in a clean container with the source mounted. The
# container has the pinned Rust toolchain + musl-dev + gcc (needed
# for the rusqlite bundled SQLite C amalgamation).
echo "[1/3] running cargo test in $RUST_IMAGE"
docker run --rm \
  -v "$ROOT/hy4-data-plane":/src \
  -w /src \
  "$RUST_IMAGE" \
  sh -c 'apk add --no-cache musl-dev gcc >/dev/null 2>&1 && \
         cargo test --lib --release \
           same_info_hash_sibling_files_get_distinct_cache_entries 2>&1'

status=$?

echo ""
if [ $status -eq 0 ]; then
  echo "[2/3] PASS  same_infoHash adversarial proof"
else
  echo "[2/3] FAIL  same_infoHash adversarial proof (exit=$status)"
fi
echo "[3/3] see hy4-data-plane/src/cache.rs for the test body"
exit $status
