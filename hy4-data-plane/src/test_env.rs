//! Test-only process-global env serialiser for the HY4 active-active gates.
//!
//! The gate flags (`HY4_ACTIVE_ACTIVE_TWO_SPAN`, `HY4_ACTIVE_ACTIVE_STEAL`)
//! are process-global env vars read at demand time. Every test that flips
//! them must hold [`env_lock`] for its whole duration, or parallel tests
//! observe each other's flags. Tests that never flip these flags need no
//! lock. (`HY4_CROSS_PROVIDER_STANDBY` is set to `1` and never removed, so
//! it needs no serialisation.)

use std::sync::{Mutex, MutexGuard};

static ENV_SERIAL: Mutex<()> = Mutex::new(());

/// Hold for the whole duration of any test that flips the active-active
/// gate flags.
pub fn env_lock() -> MutexGuard<'static, ()> {
    ENV_SERIAL.lock().unwrap_or_else(|e| e.into_inner())
}

/// Set (`true`) or remove (`false`) the T11 two-lane gate.
pub fn set_two_span(on: bool) {
    if on {
        std::env::set_var("HY4_ACTIVE_ACTIVE_TWO_SPAN", "1");
    } else {
        std::env::remove_var("HY4_ACTIVE_ACTIVE_TWO_SPAN");
    }
}

/// Set (`true`) or remove (`false`) the T12 work-steal gate.
pub fn set_steal(on: bool) {
    if on {
        std::env::set_var("HY4_ACTIVE_ACTIVE_STEAL", "1");
    } else {
        std::env::remove_var("HY4_ACTIVE_ACTIVE_STEAL");
    }
}
