//! Access to the relay's core state and credentials, as opposed to the usage ledger.

use rusqlite::Connection;

use crate::state::CommittedCore;

use super::UsageStore;

impl UsageStore {
    /// Runs `run` holding the last-committed core rows and the connection, in that
    /// lock order, so two commits cannot interleave.
    pub(crate) fn with_core<T>(
        &self,
        run: impl FnOnce(&mut CommittedCore, &mut Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let conn = self
            .conn
            .as_ref()
            .ok_or_else(|| "the state database is not open".to_string())?;
        let mut core = self
            .core
            .lock()
            .map_err(|_| "core state lock poisoned".to_string())?;
        let mut conn = conn
            .lock()
            .map_err(|_| "database lock poisoned".to_string())?;
        let result = run(&mut core, &mut conn);
        if let Ok(mut failure) = self.core_failure.lock() {
            *failure = result.as_ref().err().cloned();
        }
        result
    }

    /// Taken under the relay lock, so it orders captures the way the state changed.
    pub(crate) fn next_capture_order(&self) -> u64 {
        self.capture_order
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            .saturating_add(1)
    }

    /// Why the last core commit failed, if the latest one did.
    pub(crate) fn core_failure(&self) -> Option<String> {
        self.core_failure
            .lock()
            .ok()
            .and_then(|failure| failure.clone())
    }
}

impl UsageStore {
    /// Runs `run` on the connection alone. Never take the core-rows lock inside it.
    pub(crate) fn with_connection<T>(
        &self,
        run: impl FnOnce(&mut Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let conn = self
            .conn
            .as_ref()
            .ok_or_else(|| "the state database is not open".to_string())?;
        let mut conn = conn
            .lock()
            .map_err(|_| "database lock poisoned".to_string())?;
        run(&mut conn)
    }
}
