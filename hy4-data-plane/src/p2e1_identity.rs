//! HY4 P2E.1 deterministic fill-identity repair proof (unit-level, no I/O).
//!
//! Pins the repair of the pre-existing quirk where the fill task built
//! its `TorrentFileId` with the URL/routing UUID in the `info_hash`
//! slot, forking a UUID-based fill namespace that could never intersect
//! the plan's durable namespace (cross-read cache reuse silently dead
//! while coalescing kept working).
//!
//! E1: the shared constructor places the real durable components.
//! E2: two providers' views of the same exact TorrentFile resolve to one
//!     provider-independent byte/cache identity.
//! E3: a different TorrentFile never collides, even with a similar UUID.
//! E4 (no new code): the existing P2E cross-provider proof still passes
//!     with exact bytes and zero warm-path acquisition delta (suite).

use crate::cache::TorrentFileId;
use crate::serve::fill_torrent_file_id;

const UUID_A: &str = "tf_5de34a78-0a1a-410b-8de5-76ded2680e7d";
const UUID_B: &str = "tf_5de34a78-0a1a-410b-8de5-76ded2680e7e";
const INFO_HASH: &str = "06bfe49fdc99ad0c6fef1f761382a8181490e456";
const OTHER_HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PATH: &str = "Black.Panther.2018/file.mkv";
const SIZE: u64 = 34319716114;

#[test]
fn e1_fill_identity_uses_durable_components() {
    // Request enters via routing UUID; the fill identity must carry the
    // real Release infoHash in the info_hash position.
    let tf = fill_torrent_file_id(UUID_A.into(), INFO_HASH.into(), PATH.into(), SIZE);
    assert_eq!(tf.info_hash, INFO_HASH, "E1: info_hash position holds the real infoHash");
    assert!(
        !tf.info_hash.starts_with("tf_"),
        "E1: routing UUID must not appear in the info_hash position"
    );
    assert_eq!(tf.tf_id_durable, UUID_A, "E1: routing UUID retained for forensics only");
    assert_eq!(
        tf.durable_key,
        TorrentFileId::compute_durable_key(INFO_HASH, PATH, SIZE),
        "E1: durable key is the (infoHash, path, size) tuple"
    );
    assert!(
        tf.durable_key.contains(INFO_HASH),
        "E1: durable key is infoHash-based, got {}",
        tf.durable_key
    );
    assert!(
        !tf.durable_key.contains(UUID_A),
        "E1: durable key must not embed the routing UUID, got {}",
        tf.durable_key
    );
}

#[test]
fn e2_same_torrentfile_is_provider_independent() {
    // TorBox and RD views of the same exact TorrentFile (different
    // routing UUIDs after a DB reconstruction, no provider fields
    // anywhere in the identity) resolve to ONE byte/cache identity.
    let via_tb = fill_torrent_file_id(UUID_A.into(), INFO_HASH.into(), PATH.into(), SIZE);
    let via_rd = fill_torrent_file_id(UUID_B.into(), INFO_HASH.into(), PATH.into(), SIZE);
    assert_eq!(
        via_tb.durable_key, via_rd.durable_key,
        "E2: same TorrentFile, one durable identity across providers/UUIDs"
    );
    assert_eq!(
        via_tb.cache_key(),
        via_rd.cache_key(),
        "E2: one physical cache identity across providers/UUIDs"
    );
}

#[test]
fn e3_foreign_torrentfile_never_collides() {
    let home = fill_torrent_file_id(UUID_A.into(), INFO_HASH.into(), PATH.into(), SIZE);
    // Different infoHash, UUID shaped similarly.
    let other_hash =
        fill_torrent_file_id(UUID_B.into(), OTHER_HASH.into(), PATH.into(), SIZE);
    assert_ne!(
        home.cache_key(),
        other_hash.cache_key(),
        "E3: different infoHash must not collide"
    );
    // Same infoHash, different path.
    let other_path =
        fill_torrent_file_id(UUID_A.into(), INFO_HASH.into(), "other/file.mkv".into(), SIZE);
    assert_ne!(
        home.cache_key(),
        other_path.cache_key(),
        "E3: different path must not collide"
    );
    // Same infoHash+path, different size.
    let other_size = fill_torrent_file_id(UUID_A.into(), INFO_HASH.into(), PATH.into(), SIZE + 1);
    assert_ne!(
        home.cache_key(),
        other_size.cache_key(),
        "E3: different size must not collide"
    );
}
