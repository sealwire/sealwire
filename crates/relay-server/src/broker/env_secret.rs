use std::collections::HashMap;
use std::sync::{Mutex, OnceLock, PoisonError};

fn consumed() -> &'static Mutex<HashMap<&'static str, String>> {
    static CONSUMED: OnceLock<Mutex<HashMap<&'static str, String>>> = OnceLock::new();
    CONSUMED.get_or_init(Default::default)
}

/// Reads a secret and takes it out of the process environment, which every provider
/// process (and so every agent's `env`) inherits; later reads get the remembered value.
pub(crate) fn consume_secret_env(key: &'static str) -> Option<String> {
    let mut consumed = consumed().lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(value) = std::env::var_os(key) {
        std::env::remove_var(key);
        // Non-Unicode reads as absent, as `std::env::var` did, but still leaves the env.
        match value.into_string() {
            Ok(value) => consumed.insert(key, value),
            Err(_) => consumed.remove(key),
        };
    }
    consumed.get(key).cloned()
}

#[cfg(test)]
pub(crate) fn forget_consumed_secret_env(key: &str) {
    consumed()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .remove(key);
}
