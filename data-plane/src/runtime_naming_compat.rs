//! Runtime naming compatibility proof.
//!
//! Pins the `DATA_PLANE_*` canonical / `HY4_*` deprecated fallback
//! contract exposed by `crate::env_canonical`:
//!   1. Canonical `DATA_PLANE_FOO` works.
//!   2. Deprecated `HY4_FOO` fallback still works.
//!   3. Canonical name wins when both are set.
//!   4. Default (None) when neither is set.
//!
//! Empty values are treated as unset so that `DATA_PLANE_FOO=` falls
//! through to a deprecated `HY4_FOO=bar` rather than silently shadowing
//! it.

use crate::env_canonical;

// Each test uses a unique env-var pair to avoid process-global
// cross-test contamination (env vars are process-wide state).

#[test]
fn canonical_data_plane_var_works() {
    std::env::set_var("DATA_PLANE_COMPAT_CANON", "canonical-value");
    std::env::remove_var("HY4_COMPAT_CANON");
    assert_eq!(
        env_canonical("DATA_PLANE_COMPAT_CANON", "HY4_COMPAT_CANON"),
        Some("canonical-value".into())
    );
    std::env::remove_var("DATA_PLANE_COMPAT_CANON");
}

#[test]
fn deprecated_hy4_fallback_works() {
    std::env::remove_var("DATA_PLANE_COMPAT_OLD");
    std::env::set_var("HY4_COMPAT_OLD", "deprecated-value");
    assert_eq!(
        env_canonical("DATA_PLANE_COMPAT_OLD", "HY4_COMPAT_OLD"),
        Some("deprecated-value".into())
    );
    std::env::remove_var("HY4_COMPAT_OLD");
}

#[test]
fn canonical_wins_over_deprecated() {
    std::env::set_var("DATA_PLANE_COMPAT_BOTH", "canonical-wins");
    std::env::set_var("HY4_COMPAT_BOTH", "deprecated-loses");
    assert_eq!(
        env_canonical("DATA_PLANE_COMPAT_BOTH", "HY4_COMPAT_BOTH"),
        Some("canonical-wins".into())
    );
    std::env::remove_var("DATA_PLANE_COMPAT_BOTH");
    std::env::remove_var("HY4_COMPAT_BOTH");
}

#[test]
fn default_when_neither_set() {
    std::env::remove_var("DATA_PLANE_COMPAT_NEITHER");
    std::env::remove_var("HY4_COMPAT_NEITHER");
    assert_eq!(
        env_canonical("DATA_PLANE_COMPAT_NEITHER", "HY4_COMPAT_NEITHER"),
        None
    );
}

#[test]
fn empty_canonical_falls_through_to_deprecated() {
    // An empty canonical value must NOT shadow a set deprecated value.
    std::env::set_var("DATA_PLANE_COMPAT_EMPTY", "");
    std::env::set_var("HY4_COMPAT_EMPTY", "fallback-used");
    assert_eq!(
        env_canonical("DATA_PLANE_COMPAT_EMPTY", "HY4_COMPAT_EMPTY"),
        Some("fallback-used".into())
    );
    std::env::remove_var("DATA_PLANE_COMPAT_EMPTY");
    std::env::remove_var("HY4_COMPAT_EMPTY");
}
